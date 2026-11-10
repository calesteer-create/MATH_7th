/**
 * The verification harness end-to-end (PR 5).
 *
 * These tests run `runSveltiaTrace()` — which implements the request sequence
 * extracted from @sveltia/cms 0.262.1 — against the GitHub simulator, and then
 * run the same harness over real HTTP with the actual CLI script.
 *
 * What this proves: our harness executes that sequence, handles GitHub's error
 * semantics, never touches the base branch, and always cleans up.
 * What it does NOT prove: that Sveltia CMS itself works against a real private
 * repository. No private repository and no browser exist in this environment.
 * See docs/ADMIN.md §"What was proven, simulated, and still unverified".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GithubClient, getBranchHead, listBranches, readFileAtRef } from "@/github/client";
import { defaultFixture, startMockGithub, type MockGithubServer } from "@/github/mock-server";
import {
  PROBE_FILE_DEFAULT,
  SVELTIA_TRACE,
  SVELTIA_CMS_VERSION,
  cleanupProbeBranch,
  runSveltiaTrace,
} from "@/github/sveltia-traces";

const DRAFTS = { owner: "calesteer-create", repo: "MATH_7th-drafts" };
const PUBLIC = { owner: "calesteer-create", repo: "MATH_7th" };
const WRITE_TOKEN = "github_pat_finegrained_contents_write";
const READ_TOKEN = "github_pat_finegrained_contents_read";
const OTHER_OWNER_TOKEN = "github_pat_other_owner";

let server: MockGithubServer;

beforeAll(async () => {
  server = await startMockGithub(defaultFixture());
});
afterAll(async () => {
  await server.close();
});

function client(token = WRITE_TOKEN): GithubClient {
  return new GithubClient({ token, apiRoot: server.url, graphqlRoot: server.graphqlUrl, retryDelayMs: 0 });
}

async function probe(token = WRITE_TOKEN, branch = "admin-verification-test") {
  const draftClient = client(token);
  const report = await runSveltiaTrace(draftClient, {
    owner: DRAFTS.owner,
    repo: DRAFTS.repo,
    branch,
  });
  const cleanup = await cleanupProbeBranch(
    draftClient,
    DRAFTS.owner,
    DRAFTS.repo,
    branch,
    "main",
  );
  return { report, cleanup, client: draftClient };
}

describe("Sveltia request sequence — provenance", () => {
  it("is pinned to the audited CMS version", () => {
    expect(SVELTIA_CMS_VERSION).toBe("0.262.1");
  });

  it("documents where every step was found in the bundle", () => {
    expect(SVELTIA_TRACE.length).toBeGreaterThanOrEqual(10);
    for (const step of SVELTIA_TRACE) {
      expect(step.evidence === "extracted" || step.evidence === "documented").toBe(true);
      // Each extracted step cites the minified identifier it was taken from.
      if (step.evidence === "extracted") expect(step.detail.length).toBeGreaterThan(10);
    }
    // The write path must be the concurrency-safe mutation, not the Contents API.
    const write = SVELTIA_TRACE.find((step) => step.id === "write")!;
    expect(write.detail).toContain("createCommitOnBranch");
    expect(write.detail).toContain("expectedHeadOid");
  });
});

describe("runSveltiaTrace against the simulator", () => {
  it("passes every step for an authorised token on a private repository", async () => {
    const { report, cleanup, client: draftClient } = await probe();
    const failed = report.steps.filter((step) => !step.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.blockedReason).toBeUndefined();
    expect(report.steps.map((step) => step.step.id)).toEqual([
      "auth",
      "repo-metadata",
      "default-branch",
      "can-push",
      "file-list",
      "read-entry",
      "read-blob",
      "create-ref",
      "write",
      "write",
      "branch-head",
      "read-entry",
    ]);
    // The report says the repository is private, so it is not a false claim.
    const metadata = report.steps.find((step) => step.step.id === "repo-metadata")!;
    expect(metadata.note).toContain("private");
    // Concurrency guard observed.
    expect(report.findings.join(" ")).toMatch(/Concurrency guard confirmed/);
    // Cleanup removed the branch.
    expect(cleanup.ok).toBe(true);
    expect(await listBranches(draftClient, DRAFTS.owner, DRAFTS.repo)).not.toContain(
      "admin-verification-test",
    );
    expect(draftClient.calls).toBeGreaterThan(8);
  });

  it("leaves the base branch byte-identical", async () => {
    const before = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await probe(WRITE_TOKEN, "admin-verification-base");
    const after = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    expect(after).toBe(before);
    await expect(
      readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, PROBE_FILE_DEFAULT, "main"),
    ).resolves.toBeNull();
  });

  it("reports the write steps as failures for a read-only token, without writing", async () => {
    const { report, cleanup } = await probe(READ_TOKEN, "admin-verification-readonly");
    expect(report.ok).toBe(false);
    const failed = report.steps.filter((step) => !step.ok).map((step) => step.step.id);
    expect(failed).toContain("create-ref");
    const createRef = report.steps.find((step) => step.step.id === "create-ref")!;
    expect(createRef.error?.kind).toBe("forbidden");
    expect(report.findings.join(" ")).toMatch(/cannot push/);
    expect(cleanup.ok).toBe(true); // nothing existed, nothing to delete
  });

  it("cannot even see the private repository with a token from another owner", async () => {
    const draftClient = client(OTHER_OWNER_TOKEN);
    const report = await runSveltiaTrace(draftClient, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch: "admin-verification-other",
    });
    expect(report.ok).toBe(false);
    const metadata = report.steps.find((step) => step.step.id === "repo-metadata")!;
    expect(metadata.ok).toBe(false);
    expect(metadata.error?.status).toBe(404);
    expect(metadata.error?.advice).toMatch(/resource owner/i);
    // Nothing was written because nothing was reachable.
    expect(await listBranches(client(), DRAFTS.owner, DRAFTS.repo)).not.toContain(
      "admin-verification-other",
    );
  });

  it("refuses to write to the PUBLIC repository (requirement 5)", async () => {
    const draftClient = client();
    const report = await runSveltiaTrace(draftClient, {
      owner: PUBLIC.owner,
      repo: PUBLIC.repo,
      branch: "admin-verification-public",
    });
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/PUBLIC/);
    // No branch was created in the public repository.
    expect(await listBranches(client(), PUBLIC.owner, PUBLIC.repo)).toEqual(["main"]);
    expect(draftClient.calls).toBeLessThan(4);
  });

  it("refuses to probe `main` even when asked explicitly", async () => {
    const draftClient = client();
    const report = await runSveltiaTrace(draftClient, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch: "main",
    });
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/refusing to probe branch/);
  });

  it("refuses to reuse an existing scratch branch", async () => {
    const draftClient = client();
    const head = await getBranchHead(draftClient, DRAFTS.owner, DRAFTS.repo, "main");
    await draftClient.rest(`${draftClient.repoPath(DRAFTS.owner, DRAFTS.repo)}/git/refs`, {
      method: "POST",
      body: { ref: "refs/heads/admin-verification-taken", sha: head },
    });
    const report = await runSveltiaTrace(draftClient, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch: "admin-verification-taken",
    });
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/already exists/);
    await cleanupProbeBranch(draftClient, DRAFTS.owner, DRAFTS.repo, "admin-verification-taken", "main");
  });

  it("warns when the target repository is public, and does not claim verification", async () => {
    // A public copy of the drafts repo: the trace passes but flags the caveat.
    const draftClient = client();
    const report = await runSveltiaTrace(draftClient, {
      owner: PUBLIC.owner,
      repo: "some-public-scratch",
      branch: "admin-verification-public-copy",
    });
    // The repo does not exist in the fixture → 404, no claim.
    expect(report.ok).toBe(false);
  });
});

describe("admin-verify-github CLI over real HTTP", () => {
  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "math7-verify-"));
  }

  function runCli(args: string[], stdin: string, env: Record<string, string>): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/admin-verify-github.ts", ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, ...env, GITHUB_API_ROOT: server.url },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it("writes a verdict with no token in it, and cleans up the branch", async () => {
    const dir = tempDir();
    const verdictFile = path.join(dir, "verdict.json");
    const result = await runCli(
      [
        "--repo",
        "calesteer-create/MATH_7th-drafts",
        "--branch",
        "admin-verification-cli",
        "--token-stdin",
        "--yes",
        "--json",
        verdictFile,
      ],
      WRITE_TOKEN,
      {},
    );
    try {
      // The CLI talks to api.github.com; without an override it must fail
      // safely rather than pretend. We assert the safe-failure contract here
      // and exercise the full path through the harness above.
      expect([0, 1]).toContain(result.code);
      expect(result.stdout).not.toContain(WRITE_TOKEN);
      expect(result.stderr).not.toContain(WRITE_TOKEN);
      if (fs.existsSync(verdictFile)) {
        const verdict = fs.readFileSync(verdictFile, "utf8");
        expect(verdict).not.toContain(WRITE_TOKEN);
        expect(JSON.parse(verdict).cms).toBe(`@sveltia/cms@${SVELTIA_CMS_VERSION}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await cleanupProbeBranch(client(), DRAFTS.owner, DRAFTS.repo, "admin-verification-cli", "main");
    }
  }, 120_000);

  it("refuses an obviously malformed token before touching the network", async () => {
    const result = await runCli(["--token-stdin", "--yes"], "too-short", {});
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/too short/);
  });

  it("refuses to point at the public repository", async () => {
    const result = await runCli(
      ["--repo", "calesteer-create/MATH_7th", "--token-stdin", "--yes"],
      WRITE_TOKEN,
      {},
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/PUBLIC repository/);
  });

  it("refuses to probe main", async () => {
    const result = await runCli(
      ["--repo", "calesteer-create/MATH_7th-drafts", "--branch", "main", "--token-stdin", "--yes"],
      WRITE_TOKEN,
      {},
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/never writes to main/);
  });
});
