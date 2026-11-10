/**
 * Safety regressions for PR 5 — branch ownership and repository visibility.
 *
 * These tests exist because of two specific review findings:
 *
 *   1  Cleanup used to delete whatever branch it was pointed at. It must only
 *      ever delete a branch this run provably created (confirmed `createRef`,
 *      matching base/commit heads, matching repo/branch), and it must never
 *      touch a branch that already existed — not even to "restore" it.
 *
 *   2  A repository that GitHub does not report as `private === true` used to
 *      produce a warning and then continue. It must now stop the run before the
 *      first branch or commit, with no option that can downgrade it.
 *
 * Everything here runs against the simulator (src/github/mock-server.ts). The
 * simulator models GitHub's documented behaviour; it is evidence, not proof,
 * and Sveltia CMS stays EXPERIMENTAL until the owner's real-repo run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GITHUB_API_ROOT,
  GithubClient,
  createBranch,
  probeBranchExistence,
  resolveApiRoot,
  getBranchHead,
  listBranches,
} from "@/github/client";
import {
  fixtureWithRepos,
  startMockGithub,
  type MockGithubServer,
  type MockGithubState,
} from "@/github/mock-server";
import {
  cleanupProbeBranch,
  runSveltiaTrace,
  type ProbeBranchClaim,
} from "@/github/sveltia-traces";
import {
  DRAFT_REPO_DEFAULT,
  PUBLIC_REPO,
  checkWritableRepo,
  isWritableTarget,
  resolveDraftRepo,
  verifyWritePreconditions,
} from "@/media/repo-guard";

const WRITE_TOKEN = "github_pat_finegrained_contents_write";
const DRAFTS = { owner: "calesteer-create", repo: "MATH_7th-drafts" };

/**
 * Repositories used across this file, all reachable with the write token:
 *   - a PRIVATE repo with an innocent name (must be usable)
 *   - a PUBLIC repo with an innocent name (must never be written to)
 */
const NEUTRAL_PRIVATE = { owner: "calesteer-create", name: "notes-and-plans", isPrivate: true };
const NEUTRAL_PUBLIC = { owner: "calesteer-create", name: "site-assets", isPrivate: false };

function makeClient(server: MockGithubServer): GithubClient {
  return new GithubClient({
    token: WRITE_TOKEN,
    apiRoot: server.url,
    graphqlRoot: server.graphqlUrl,
    retryDelayMs: 0,
  });
}

function writeRequests(state: MockGithubState): string[] {
  return state.requests
    .filter((entry) => entry.method !== "GET")
    .map((entry) => `${entry.method} ${entry.path}`);
}

/** A claim that is well-formed but was never issued by a createRef call. */
function forgedClaim(overrides: Partial<ProbeBranchClaim> = {}): ProbeBranchClaim {
  return {
    owner: DRAFTS.owner,
    repo: DRAFTS.repo,
    branch: "admin-verification-forged",
    baseOid: "0".repeat(40),
    createdOid: "0".repeat(40),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("repository visibility gate (fix 2)", () => {
  it("refuses a PUBLIC repository whatever its name is", () => {
    const verdict = checkWritableRepo(`${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`, {
      full_name: `${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`,
      private: false,
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/not the agreed drafts destination|PRIVATE/);
    expect(
      checkWritableRepo(`${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`, {
        full_name: `${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`,
        private: true,
      }).problem,
    ).toMatch(/not the agreed drafts destination/);
    expect(isWritableTarget(`${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`, {
      full_name: `${NEUTRAL_PUBLIC.owner}/${NEUTRAL_PUBLIC.name}`,
      private: false,
    })).toBe(false);
  });

  it("treats a missing or non-boolean `private` as not private", () => {
    const name = `${NEUTRAL_PRIVATE.owner}/${NEUTRAL_PRIVATE.name}`;
    expect(checkWritableRepo(name, { full_name: name, private: null }).writable).toBe(false);
    expect(
      checkWritableRepo(name, {
        full_name: name,
        // GitHub returning a string ("true") is not proof of anything.
        private: "true" as unknown as boolean,
      }).writable,
    ).toBe(false);
  });

  it("refuses when GitHub reports a different repository than the configured one", () => {
    const verdict = checkWritableRepo(`${DRAFTS.owner}/${DRAFTS.repo}`, {
      full_name: `${PUBLIC_REPO}`,
      private: true,
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/different repository/);
  });

  it("refuses any foreign repository in the generator's destination mode", () => {
    const foreign = `${NEUTRAL_PRIVATE.owner}/${NEUTRAL_PRIVATE.name}`;
    // Even with GitHub-style proof of privacy, the generator destination mode
    // only accepts the agreed repository: a name is not a destination contract.
    expect(checkWritableRepo(foreign).writable).toBe(false);
    expect(
      checkWritableRepo(foreign, { full_name: foreign, private: true }).writable,
    ).toBe(false);
    expect(
      isWritableTarget(foreign, { full_name: foreign, private: true }),
    ).toBe(false);
    // "verified" mode is what the CLI uses; it still needs live proof.
    expect(checkWritableRepo(foreign, null, { destination: "verified" }).writable).toBe(false);
    expect(
      checkWritableRepo(foreign, { full_name: foreign, private: true }, { destination: "verified" })
        .writable,
    ).toBe(true);
    expect(
      checkWritableRepo(foreign, { full_name: foreign, private: false }, { destination: "verified" })
        .writable,
    ).toBe(false);
  });

  it("still allows the configured private drafts repository", () => {
    expect(checkWritableRepo(DRAFT_REPO_DEFAULT).writable).toBe(true);
    expect(
      checkWritableRepo(DRAFT_REPO_DEFAULT, { full_name: DRAFT_REPO_DEFAULT, private: true }).writable,
    ).toBe(true);
  });

  it("refuses a renamed destination instead of calling it private", () => {
    const resolution = resolveDraftRepo({ DRAFT_REPO: `${NEUTRAL_PRIVATE.owner}/${NEUTRAL_PRIVATE.name}` });
    expect(resolution.problem).toMatch(/not the agreed drafts destination/);
    // Static code cannot know the visibility of a renamed repository, so it
    // must never be treated as a destination.
    expect(resolution.privacyProvable).toBe(false);
    // The agreed destination is the only one that resolves without a problem.
    expect(resolveDraftRepo({}).problem).toBeNull();
    expect(resolveDraftRepo({}).privacyProvable).toBe(true);
  });

  it("never writes to a PUBLIC repo with an innocent name, even with a valid write token", async () => {
    const state = fixtureWithRepos({ repos: [NEUTRAL_PRIVATE, NEUTRAL_PUBLIC] });
    const server = await startMockGithub(state);
    try {
      const client = makeClient(server);
      const writesBefore = writeRequests(state).length;
      const report = await runSveltiaTrace(client, {
        owner: NEUTRAL_PUBLIC.owner,
        repo: NEUTRAL_PUBLIC.name,
        branch: "admin-verification-public-neutral",
      });

      expect(report.ok).toBe(false);
      expect(report.blockedReason).toMatch(/private=false/);
      expect(report.blockedReason).toMatch(/PRIVATE/);
      expect(report.claim).toBeUndefined();
      // No branch, no commit, no deletion — the write budget is untouched.
      expect(writeRequests(state).length).toBe(writesBefore);
      expect(await listBranches(client, NEUTRAL_PUBLIC.owner, NEUTRAL_PUBLIC.name)).toEqual(["main"]);
    } finally {
      await server.close();
    }
  });

  it("cannot be bypassed: no option, env var or client setting turns the refusal off", async () => {
    const state = fixtureWithRepos({ repos: [NEUTRAL_PUBLIC] });
    const server = await startMockGithub(state);
    try {
      const client = makeClient(server);
      // Every knob a caller could plausibly reach for is ignored.
      for (const attempt of [
        { cleanupBranch: false },
        { deleteProbeFile: true },
        { probePath: "content/probe.json" },
        { samplePath: "content/README.md" },
      ]) {
        const report = await runSveltiaTrace(client, {
          owner: NEUTRAL_PUBLIC.owner,
          repo: NEUTRAL_PUBLIC.name,
          branch: `admin-verification-bypass-${Object.keys(attempt)[0]}`,
          ...attempt,
        });
        expect(report.ok).toBe(false);
        expect(report.blockedReason).toMatch(/private=false/);
      }
      expect(writeRequests(state)).toEqual([]);
      expect(await listBranches(client, NEUTRAL_PUBLIC.owner, NEUTRAL_PUBLIC.name)).toEqual(["main"]);
    } finally {
      await server.close();
    }
  });
});

describe("scratch-branch ownership (fix 1)", () => {
  let server: MockGithubServer;
  let client: GithubClient;

  beforeAll(async () => {
    server = await startMockGithub(
      fixtureWithRepos({ repos: [NEUTRAL_PRIVATE, NEUTRAL_PUBLIC] }),
    );
    client = makeClient(server);
  });
  afterAll(async () => {
    await server.close();
  });

  it("refuses to delete a branch that already existed, and leaves it byte-identical", async () => {
    const branch = "admin-verification-preexisting";
    const base = (await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, "main"))!;
    await createBranch(client, DRAFTS.owner, DRAFTS.repo, branch, base);

    const headBefore = await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, branch);
    const report = await runSveltiaTrace(client, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch,
    });

    // The run refuses and produces no ownership claim.
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/already exists/);
    expect(report.claim).toBeUndefined();

    // Even if cleanup is called with the same name, it deletes nothing.
    const cleanup = await cleanupProbeBranch(client, DRAFTS.owner, DRAFTS.repo, branch, "main");
    expect(cleanup.deleted).toBe(false);
    expect(cleanup.reason).toBe("not-owned");

    // The branch is still there, at the same head.
    expect(await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, branch)).toBe(headBefore);
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).toContain(branch);

    // tidy up: the test itself removes the branch it made
    await client.rest(`${client.repoPath(DRAFTS.owner, DRAFTS.repo)}/git/refs/heads/${branch}`, {
      method: "DELETE",
    });
  });

  it("does not delete another branch when creating ours fails", async () => {
    const bystander = "admin-verification-bystander";
    const base = (await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, "main"))!;
    await createBranch(client, DRAFTS.owner, DRAFTS.repo, bystander, base);
    const bystanderHead = await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, bystander);

    // A read-only token makes `createRef` fail (403) — the branch is never
    // created, so there is nothing this run could legitimately delete.
    const readonly = new GithubClient({
      token: "github_pat_finegrained_contents_read",
      apiRoot: server.url,
      graphqlRoot: server.graphqlUrl,
      retryDelayMs: 0,
    });
    const report = await runSveltiaTrace(readonly, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch: "admin-verification-never-created",
    });
    expect(report.ok).toBe(false);
    expect(report.claim).toBeUndefined();
    // A token that cannot push is refused before the write steps, not halfway.
    expect(report.blockedReason).toMatch(/cannot push/);
    expect(report.steps.some((step) => step.step.id === "create-ref")).toBe(false);

    // Cleanup with no claim refuses: a name we never created is "absent", and
    // a branch that exists but is not ours is "not-owned". Neither is deleted.
    const absent = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      "admin-verification-never-created",
      "main",
    );
    expect(absent.deleted).toBe(false);
    expect(absent.reason).toBe("absent");

    const notOurs = await cleanupProbeBranch(client, DRAFTS.owner, DRAFTS.repo, bystander, "main");
    expect(notOurs.deleted).toBe(false);
    expect(notOurs.reason).toBe("not-owned");

    // The unrelated branch is exactly where it was.
    expect(await getBranchHead(client, DRAFTS.owner, DRAFTS.repo, bystander)).toBe(bystanderHead);
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).not.toContain(
      "admin-verification-never-created",
    );

    await client
      .rest(`${client.repoPath(DRAFTS.owner, DRAFTS.repo)}/git/refs/heads/${bystander}`, { method: "DELETE" })
      .catch(() => undefined);
  });

  it("refuses to delete a branch whose head no longer matches what we created", async () => {
    const branch = "admin-verification-moved";
    const report = await runSveltiaTrace(client, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch,
    });
    expect(report.claim).toBeDefined();
    expect(report.commit).toBeDefined();

    // Somebody else pushes on top of our scratch branch.
    server.simulateConcurrentCommit(DRAFTS.repo, branch, "content/other-editor.json", "{}");

    const cleanup = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      branch,
      "main",
      report.claim,
      report.commit,
    );
    expect(cleanup.deleted).toBe(false);
    expect(cleanup.reason).toBe("head-mismatch");
    // Left in place on purpose; the caller is told to inspect it.
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).toContain(branch);

    await client
      .rest(`${client.repoPath(DRAFTS.owner, DRAFTS.repo)}/git/refs/heads/${branch}`, { method: "DELETE" })
      .catch(() => undefined);
  });

  it("refuses a claim that belongs to a different repository", async () => {
    const cleanup = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      "admin-verification-wrong-repo",
      "main",
      forgedClaim({ repo: "some-other-repo" }),
    );
    expect(cleanup.deleted).toBe(false);
    expect(cleanup.reason).toBe("not-owned");
  });

  it("reports a cleanup failure safely, without retrying or deleting anything else", async () => {
    const branch = "admin-verification-cleanup-fails";
    const report = await runSveltiaTrace(client, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch,
    });
    expect(report.claim).toBeDefined();

    // Make every request fail the way an outage or a revoked token would.
    server.state.failNext = 50;
    const cleanup = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      branch,
      "main",
      report.claim,
      report.commit,
    );
    server.state.failNext = 0;

    expect(cleanup.ok).toBe(false);
    expect(cleanup.deleted).toBe(false);
    expect(cleanup.reason).toBe("error");
    expect(cleanup.note).not.toMatch(WRITE_TOKEN);
    expect(cleanup.note.length).toBeGreaterThan(0);
    // The branch survived a failed cleanup — nothing was force-deleted.
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).toContain(branch);

    // A second, clean call succeeds and only removes our own branch.
    const retry = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      branch,
      "main",
      report.claim,
      report.commit,
    );
    expect(retry.deleted).toBe(true);
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).not.toContain(branch);
  });

  it("never treats a name alone as ownership, even for the default-branch check", async () => {
    const cleanup = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      "main",
      "main",
      forgedClaim({ branch: "main" }),
    );
    expect(cleanup.deleted).toBe(false);
    expect(cleanup.reason).toBe("refused-default");
  });

  it("accepts ownership only after createRef succeeded, and never for a pre-existing branch", async () => {
    const branch = "admin-verification-happy-path";
    const seen: ProbeBranchClaim[] = [];
    const report = await runSveltiaTrace(client, {
      owner: DRAFTS.owner,
      repo: DRAFTS.repo,
      branch,
      onCreateBranch: (claim) => seen.push(claim),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ branch, owner: DRAFTS.owner, repo: DRAFTS.repo });
    expect(report.claim).toEqual(seen[0]);

    const cleanup = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      branch,
      "main",
      report.claim,
      report.commit,
    );
    expect(cleanup.reason).toBe("deleted");
    expect(await listBranches(client, DRAFTS.owner, DRAFTS.repo)).not.toContain(branch);

    // Running again on the same name is refused (the branch is gone, but a
    // claim from the previous run must not be reused).
    const second = await cleanupProbeBranch(
      client,
      DRAFTS.owner,
      DRAFTS.repo,
      branch,
      "main",
      report.claim,
      report.commit,
    );
    expect(second.deleted).toBe(false);
    expect(second.reason).toBe("absent");
  });
});

describe("the CLI refuses before writing", () => {
  it("points at the real API by default, never at a simulator", () => {
    // Guards against a test-only override leaking into the shipped default.
    expect(GITHUB_API_ROOT).toBe("https://api.github.com");
    expect(resolveApiRoot({} as unknown as NodeJS.ProcessEnv)).toBe("https://api.github.com");
  });

  it("never sends a token to a host chosen by an environment variable", () => {
    // Only loopback may override the endpoint, and only for tests.
    for (const hostile of [
      "https://evil.example.com",
      "https://api.github.com.evil.example.com",
      "http://localhost.evil.com:8080",
      "http://10.0.0.1:8080",
      "//evil.example.com",
    ]) {
      expect(resolveApiRoot({ GITHUB_API_ROOT: hostile } as unknown as NodeJS.ProcessEnv)).toBe(
        "https://api.github.com",
      );
    }
    for (const loopback of ["http://127.0.0.1:1234", "http://localhost:1234/", "http://[::1]:9"]) {
      expect(resolveApiRoot({ GITHUB_API_ROOT: loopback } as unknown as NodeJS.ProcessEnv)).toBe(
        loopback.replace(/\/$/, ""),
      );
    }
  });
});

describe("write preconditions before the probe touches anything", () => {
  const absent = { state: "absent", ref: "refs/heads/admin-verification-preflight" } as const;
  const base = {
    requestedRepo: DRAFT_REPO_DEFAULT,
    visibility: { full_name: DRAFT_REPO_DEFAULT, private: true },
    access: { full_name: DRAFT_REPO_DEFAULT, push: true, pull: true, reported: true },
    branchExistence: absent,
    branch: "admin-verification-preflight",
    defaultBranch: "main",
  };

  it("allows the normal case only with confirmed-absent branch evidence", () => {
    expect(verifyWritePreconditions(base).writable).toBe(true);
  });

  it("refuses when GitHub answers for a different repository", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      visibility: { full_name: "someone/else-repo", private: true },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/different repository/);
  });

  it("refuses a public repository, even at the agreed name", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      visibility: { full_name: DRAFT_REPO_DEFAULT, private: false },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/private=false/);
  });

  /* ── the six branch-evidence cases ─────────────────────────────────────── */

  it("1. confirmed absence allows the write", () => {
    const verdict = verifyWritePreconditions(base);
    expect(verdict.writable).toBe(true);
    expect(verdict.problem).toBeNull();
  });

  it("2. an existing branch is refused and kept", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      branchExistence: { state: "present", ref: absent.ref, head: "a".repeat(40) },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/already exists/);
    expect(verdict.problem).toMatch(/left untouched/);
  });

  it("3. a 403 on the branch lookup is never read as absence", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      branchExistence: { state: "unknown", ref: absent.ref, reason: "forbidden (403): nope" },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/could not confirm/);
    expect(verdict.problem).toMatch(/not proof of absence/);
  });

  it("4. a 500 / network failure is never read as absence", () => {
    for (const reason of ["server_error (500): boom", "network (0): socket hang up"]) {
      const verdict = verifyWritePreconditions({
        ...base,
        branchExistence: { state: "unknown", ref: absent.ref, reason },
      });
      expect(verdict.writable).toBe(false);
      expect(verdict.problem).toMatch(/could not confirm/);
    }
  });

  it("5. incomplete evidence is never read as absence", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      branchExistence: {
        state: "unknown",
        ref: absent.ref,
        reason: "GitHub answered but the ref body was incomplete",
      },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/could not confirm/);
  });

  it("refuses the default branch and main", () => {
    for (const branch of ["main", "trunk"]) {
      const verdict = verifyWritePreconditions({ ...base, branch, defaultBranch: "trunk" });
      expect(verdict.writable).toBe(false);
      expect(verdict.problem).toMatch(/scratch branch/);
    }
  });

  it("refuses when GitHub reports no permissions block at all", () => {
    // Missing data must not be treated as "probably fine".
    const verdict = verifyWritePreconditions({ ...base, access: null });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/did not report a permissions block/);
    const unreported = verifyWritePreconditions({
      ...base,
      access: { full_name: DRAFT_REPO_DEFAULT, push: true, reported: false },
    });
    expect(unreported.writable).toBe(false);
  });

  it("refuses when the user's repository access does not allow pushing", () => {
    const verdict = verifyWritePreconditions({
      ...base,
      access: { full_name: DRAFT_REPO_DEFAULT, push: false, pull: true, reported: true },
    });
    expect(verdict.writable).toBe(false);
    expect(verdict.problem).toMatch(/cannot push/);
    // The wording must not pretend this is a token-scope check.
    expect(verdict.problem).toMatch(/authenticated user/);
  });

  it("does not claim to prove the token's Contents permission", () => {
    // `access.push` describes the user. A read-only PAT owned by a user who can
    // push passes this check, which is exactly why it is documented and why the
    // probe's only real proof is a write GitHub accepts.
    const verdict = verifyWritePreconditions({ ...base });
    expect(verdict.writable).toBe(true);
    expect(verdict).not.toHaveProperty("contentsProven");
  });

  it("is re-checked inside the trace, so a preflighted run cannot be tricked later", async () => {
    const state = fixtureWithRepos({ repos: [{ ...NEUTRAL_PRIVATE }] });
    const server = await startMockGithub(state);
    try {
      const client = makeClient(server);
      // The repository is private at preflight time...
      expect(
        verifyWritePreconditions({
          ...base,
          requestedRepo: `${NEUTRAL_PRIVATE.owner}/${NEUTRAL_PRIVATE.name}`,
          visibility: { full_name: `${NEUTRAL_PRIVATE.owner}/${NEUTRAL_PRIVATE.name}`, private: true },
        }).writable,
      ).toBe(true);
      // ...but if GitHub later says it is public, the trace still refuses.
      const repo = state.repos.find((candidate) => candidate.name === NEUTRAL_PRIVATE.name)!;
      repo.private = false;
      const report = await runSveltiaTrace(client, {
        owner: NEUTRAL_PRIVATE.owner,
        repo: NEUTRAL_PRIVATE.name,
        branch: "admin-verification-late-flip",
      });
      expect(report.ok).toBe(false);
      expect(report.blockedReason).toMatch(/private=false/);
      expect(report.claim).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe("branch lookup fails closed (finding 3)", () => {
  const DRAFTS_REPO = { owner: "calesteer-create", repo: "MATH_7th-drafts" };

  let stateAfter: ReturnType<typeof fixtureWithRepos>;

  async function runAgainst(
    arrange: (state: ReturnType<typeof fixtureWithRepos>) => void,
    branch: string,
  ) {
    const state = fixtureWithRepos({});
    arrange(state);
    stateAfter = state;
    const server = await startMockGithub(state);
    try {
      const client = makeClient(server);
      const writesBefore = state.requests.filter(
        (entry) => entry.path !== "/graphql" && entry.method !== "GET",
      ).length;
      const evidence: unknown[] = [];
      const report = await runSveltiaTrace(client, {
        owner: DRAFTS_REPO.owner,
        repo: DRAFTS_REPO.repo,
        branch,
        onBranchEvidence: (value) => evidence.push(value),
      });
      const writesAfter = state.requests.filter(
        (entry) => entry.path !== "/graphql" && entry.method !== "GET",
      ).length;
      return {
        report,
        state: stateAfter,
        client,
        evidence,
        createdWrites: writesAfter - writesBefore,
      };
    } finally {
      await server.close();
    }
  }

  it("1. confirmed absence: the probe proceeds and creates the branch", async () => {
    const { report, evidence, createdWrites } = await runAgainst(() => {}, "admin-verification-absent");
    expect(evidence).toEqual([
      { state: "absent", ref: "refs/heads/admin-verification-absent" },
    ]);
    expect(report.ok).toBe(true);
    expect(createdWrites).toBeGreaterThan(0);
    expect(report.claim?.branch).toBe("admin-verification-absent");
  });

  it("2. existing branch: refused, nothing created, branch untouched", async () => {
    const branch = "admin-verification-exists";
    const { report, evidence, createdWrites } = await runAgainst((state) => {
      const repo = state.repos.find((candidate) => candidate.name === DRAFTS_REPO.repo)!;
      const head = repo.heads.get("main")!;
      repo.branches.set(branch, new Map(repo.branches.get("main")!));
      repo.heads.set(branch, head);
      repo.commitCount.set(branch, 1);
    }, branch);

    expect(evidence).toEqual([expect.objectContaining({ state: "present" })]);
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/already exists/);
    expect(createdWrites).toBe(0);
    expect(report.claim).toBeUndefined();
    // The branch is still in the simulator's state, at the commit it had.
    const repoAfter = stateAfter.repos.find((candidate) => candidate.name === DRAFTS_REPO.repo)!;
    expect(repoAfter.branches.has(branch)).toBe(true);
  });

  it("3. 403 on the lookup: blocked, no write", async () => {
    const { report, evidence, createdWrites } = await runAgainst((state) => {
      state.denyRefReads = true;
    }, "admin-verification-forbidden");
    expect(evidence).toEqual([expect.objectContaining({ state: "unknown" })]);
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/could not confirm/);
    expect(report.claim).toBeUndefined();
    expect(createdWrites).toBe(0);
  });

  it("4. 500 / network failure on the lookup: blocked, no write", async () => {
    const { report, evidence, createdWrites } = await runAgainst((state) => {
      // Fail deterministically *at the lookup*: once the repo metadata has
      // been read, every further request answers 500 (past the retry budget).
      state.failOn = (entry) => entry.path.includes("/git/ref/heads/");
    }, "admin-verification-server-error");
    expect(evidence).toEqual([expect.objectContaining({ state: "unknown" })]);
    expect(report.ok).toBe(false);
    expect(report.blockedReason).toMatch(/could not confirm/);
    expect(createdWrites).toBe(0);
  });

  it("5. incomplete answer: blocked, no write", async () => {
    // A branch listing that hides our branch must not be consulted at all: the
    // decision comes from the exact ref, so this run proceeds even though the
    // listing would have said "absent".
    const { report, evidence } = await runAgainst((state) => {
      state.truncateBranchListing = [DRAFTS_REPO.repo];
    }, "admin-verification-listing-hidden");
    expect(evidence).toEqual([expect.objectContaining({ state: "absent" })]);
    expect(report.ok).toBe(true);

    // And a lookup that cannot reach GitHub is `unknown`, not absence.
    const unreachable = new GithubClient({
      token: WRITE_TOKEN,
      apiRoot: "http://127.0.0.1:9",
      graphqlRoot: "http://127.0.0.1:9/graphql",
      retryDelayMs: 0,
      maxRetries: 0,
    });
    const incomplete = await probeBranchExistence(
      unreachable,
      DRAFTS_REPO.owner,
      DRAFTS_REPO.repo,
      "admin-verification-unreachable",
    );
    expect(incomplete).toMatchObject({ state: "unknown" });
  });

  it("6. a lookup failure happens before any write, in every failing case", async () => {
    for (const arrange of [
      (state: ReturnType<typeof fixtureWithRepos>) => {
        state.denyRefReads = true;
      },
      (state: ReturnType<typeof fixtureWithRepos>) => {
        state.failOn = (entry) => entry.path.includes("/git/ref/heads/");
      },
    ]) {
      const { report, createdWrites } = await runAgainst(arrange, "admin-verification-no-write");
      expect(report.claim).toBeUndefined();
      expect(createdWrites).toBe(0);
    }
  });
});
