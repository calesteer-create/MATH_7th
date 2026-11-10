/**
 * GitHub client behaviour against the simulator (PR 5).
 *
 * ⚠ These tests prove OUR client's behaviour and GitHub's *documented*
 * semantics as reproduced by src/github/mock-server.ts. They do NOT prove that
 * Sveltia CMS works against a real private repository — see docs/ADMIN.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GithubClient,
  GithubError,
  commitOnBranch,
  createBranch,
  deleteBranch,
  getBranchHead,
  getRepo,
  getViewer,
  listBranches,
  listTree,
  readBlob,
  readFileAtRef,
  viewerCanPush,
} from "@/github/client";
import { defaultFixture, startMockGithub, type MockGithubServer } from "@/github/mock-server";

const DRAFTS = { owner: "calesteer-create", repo: "MATH_7th-drafts" };
const PUBLIC = { owner: "calesteer-create", repo: "MATH_7th" };

let server: MockGithubServer;

beforeAll(async () => {
  server = await startMockGithub(defaultFixture());
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.state.requests.length = 0;
  server.state.failNext = 0;
  server.state.rateLimited = false;
});

function client(token = "github_pat_finegrained_contents_write"): GithubClient {
  return new GithubClient({
    token,
    apiRoot: server.url,
    graphqlRoot: server.graphqlUrl,
    retryDelayMs: 0,
  });
}

const VALID = "github_pat_finegrained_contents_write";
const READ_ONLY = "github_pat_finegrained_contents_read";
const NO_CONTENTS = "github_pat_finegrained_no_contents";
const OTHER_OWNER = "github_pat_other_owner";
const EXPIRED = "github_pat_expired";

describe("authentication", () => {
  it("accepts a valid token and reports the account", async () => {
    await expect(getViewer(client())).resolves.toMatchObject({ login: "owner" });
    expect(server.state.requests[0]?.authenticated).toBe(true);
  });

  it("sends the token as `token <PAT>`, like Sveltia does", async () => {
    const seen: string[] = [];
    const probing = new GithubClient({
      token: VALID,
      apiRoot: server.url,
      graphqlRoot: server.graphqlUrl,
      retryDelayMs: 0,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push(String(headers.get("Authorization")));
        return fetch(input as string, init);
      }) as typeof fetch,
    });
    await getViewer(probing);
    expect(seen[0]).toBe(`token ${VALID}`);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const anonymous = new GithubClient({
      token: "not-a-real-token",
      apiRoot: server.url,
      graphqlRoot: server.graphqlUrl,
      retryDelayMs: 0,
    });
    const error = await getViewer(anonymous).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).kind).toBe("unauthorized");
    expect((error as GithubError).status).toBe(401);
  });

  it("rejects an expired token and says what to do", async () => {
    const error = (await getViewer(client(EXPIRED)).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("unauthorized");
    expect(error.advice).toMatch(/expired|revoked/);
  });

  it("never puts the token in the error message", async () => {
    const error = (await getViewer(client(EXPIRED)).catch((caught: unknown) => caught)) as GithubError;
    expect(error.message).not.toContain(EXPIRED);
    expect(error.advice).not.toContain(EXPIRED);
    expect(JSON.stringify({ m: error.message, a: error.advice })).not.toContain("github_pat_");
  });

  it("refuses to send a token over plain HTTP to a non-local host", () => {
    expect(
      () => new GithubClient({ token: VALID, apiRoot: "http://api.example.com" }),
    ).toThrow(/insecure connection/);
  });
});

describe("private repository visibility", () => {
  it("makes a private repository invisible (404) to a token without access", async () => {
    const error = (await getRepo(client(OTHER_OWNER), DRAFTS.owner, DRAFTS.repo).catch(
      (caught: unknown) => caught,
    )) as GithubError;
    expect(error.kind).toBe("not_found");
    expect(error.status).toBe(404);
    // The advice must explain the fine-grained-token trap, not just "not found".
    expect(error.advice).toMatch(/resource owner/i);
  });

  it("makes the private repository invisible to a token with no contents permission", async () => {
    const error = (await getRepo(client(NO_CONTENTS), DRAFTS.owner, DRAFTS.repo).catch(
      (caught: unknown) => caught,
    )) as GithubError;
    expect(error.status).toBe(404);
  });

  it("shows the private repository to an authorised token", async () => {
    const repo = await getRepo(client(), DRAFTS.owner, DRAFTS.repo);
    expect(repo.private).toBe(true);
    expect(repo.full_name).toBe("calesteer-create/MATH_7th-drafts");
    expect(repo.permissions?.push).toBe(true);
  });

  it("reports a read-only token as non-pushable", async () => {
    const repo = await getRepo(client(READ_ONLY), DRAFTS.owner, DRAFTS.repo);
    expect(repo.permissions?.push).toBe(false);
  });

  it("keeps the public repository readable", async () => {
    const repo = await getRepo(client(), PUBLIC.owner, PUBLIC.repo);
    expect(repo.private).toBe(false);
  });
});

describe("insufficient permissions", () => {
  it("answers viewerCanPush=false for a read-only token", async () => {
    await expect(
      viewerCanPush(client(READ_ONLY), DRAFTS.owner, DRAFTS.repo, "refs/heads/main"),
    ).resolves.toBe(false);
  });

  it("answers viewerCanPush=true for a writing token", async () => {
    await expect(
      viewerCanPush(client(), DRAFTS.owner, DRAFTS.repo, "refs/heads/main"),
    ).resolves.toBe(true);
  });

  it("refuses a commit with an explicit permission error, not a silent failure", async () => {
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    const error = (await commitOnBranch(
      client(READ_ONLY),
      DRAFTS.owner,
      DRAFTS.repo,
      "main",
      head!,
      "nope",
      { additions: [{ path: "x.json", contents: "{}" }] },
    ).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("graphql");
    expect(error.message).toMatch(/not accessible by personal access token/i);
  });

  it("refuses a REST write (branch creation) with 403", async () => {
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    const error = (await createBranch(
      client(READ_ONLY),
      DRAFTS.owner,
      DRAFTS.repo,
      "probe-readonly",
      head!,
    ).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("forbidden");
    expect(error.status).toBe(403);
  });
});

describe("reading files", () => {
  it("lists the branch tree recursively", async () => {
    const { tree, truncated } = await listTree(client(), DRAFTS.owner, DRAFTS.repo, "main");
    expect(truncated).toBe(false);
    expect(tree.map((entry) => entry.path)).toContain("public/admin/config.yml");
    expect(tree.every((entry) => entry.type === "blob")).toBe(true);
    // 404 for a missing branch is an error, not an empty list.
    await expect(listTree(client(), DRAFTS.owner, DRAFTS.repo, "nope")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("reads an entry through GraphQL object(expression:) as Sveltia does", async () => {
    const text = await readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, "content/README.md", "main");
    expect(text).toBe("# drafts\n");
    await expect(
      readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, "missing.json", "main"),
    ).resolves.toBeNull();
  });

  it("reads a blob's raw bytes by sha", async () => {
    const { tree } = await listTree(client(), DRAFTS.owner, DRAFTS.repo, "main");
    const entry = tree.find((candidate) => candidate.path === "content/README.md")!;
    const raw = await readBlob(client(), DRAFTS.owner, DRAFTS.repo, entry.sha);
    expect(raw).toBe("# drafts\n");
  });

  it("resolves the branch head via GraphQL", async () => {
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    await expect(getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "missing")).resolves.toBeNull();
  });
});

describe("writing: commits, branches and conflicts", () => {
  it("creates a branch, commits a file, and reads it back", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-write", start!);
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "probe-write");
    expect(head).toBe(start);

    const payload = JSON.stringify({ probe: true, n: 1 });
    const commit = await commitOnBranch(
      client(),
      DRAFTS.owner,
      DRAFTS.repo,
      "probe-write",
      head!,
      "test: probe\n\nsecond line",
      { additions: [{ path: "content/probe.json", contents: payload }] },
    );
    expect(commit.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.oid).not.toBe(head);

    await expect(
      readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, "content/probe.json", "probe-write"),
    ).resolves.toBe(payload);
    // The default branch must be untouched.
    await expect(
      readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, "content/probe.json", "main"),
    ).resolves.toBeNull();
    // The commit was a single GraphQL call carrying the message.
    const commitCalls = server.state.requests.filter((r) => r.graphqlOperation === "createCommitOnBranch");
    expect(commitCalls.length).toBeGreaterThan(0);
  });

  it("rejects a commit based on a stale branch head (concurrent edit)", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-conflict", start!);
    const staleHead = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "probe-conflict");

    // Another editor commits first.
    server.simulateConcurrentCommit(DRAFTS.repo, "probe-conflict", "content/other.json", '{"other":1}');

    const error = (await commitOnBranch(
      client(),
      DRAFTS.owner,
      DRAFTS.repo,
      "probe-conflict",
      staleHead!,
      "test: stale",
      { additions: [{ path: "content/probe.json", contents: "{}" }] },
    ).catch((caught: unknown) => caught)) as GithubError;
    // Mapped to a dedicated conflict kind, so callers can retry instead of
    // treating it as a permissions problem.
    expect(error.kind).toBe("conflict");
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/expectedHeadOid/);
    expect(error.advice).toMatch(/concurrency guard/i);
  });

  it("rejects a second commit with the same expectedHeadOid", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-double", start!);
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "probe-double");
    await commitOnBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-double", head!, "first", {
      additions: [{ path: "a.json", contents: "{}" }],
    });
    await expect(
      commitOnBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-double", head!, "second", {
        additions: [{ path: "b.json", contents: "{}" }],
      }),
    ).rejects.toThrow(/expectedHeadOid/);
  });

  it("deletes a commit's file through a second commit (delete ref path)", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-delete-file", start!);
    const head = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "probe-delete-file");
    await commitOnBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-delete-file", head!, "add", {
      additions: [{ path: "tmp.json", contents: "{}" }],
    });
    const afterAdd = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "probe-delete-file");
    await commitOnBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-delete-file", afterAdd!, "remove", {
      deletions: [{ path: "tmp.json" }],
    });
    await expect(
      readFileAtRef(client(), DRAFTS.owner, DRAFTS.repo, "tmp.json", "probe-delete-file"),
    ).resolves.toBeNull();
  });

  it("deletes a scratch branch and treats a second delete as already gone", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-cleanup", start!);
    expect(await listBranches(client(), DRAFTS.owner, DRAFTS.repo)).toContain("probe-cleanup");
    await expect(deleteBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-cleanup")).resolves.toBe(true);
    await expect(deleteBranch(client(), DRAFTS.owner, DRAFTS.repo, "probe-cleanup")).resolves.toBe(false);
    expect(await listBranches(client(), DRAFTS.owner, DRAFTS.repo)).not.toContain("probe-cleanup");
  });

  it("refuses to create a branch that already exists (422)", async () => {
    const start = await getBranchHead(client(), DRAFTS.owner, DRAFTS.repo, "main");
    const error = (await createBranch(client(), DRAFTS.owner, DRAFTS.repo, "main", start!).catch(
      (caught: unknown) => caught,
    )) as GithubError;
    expect(error.kind).toBe("unprocessable");
    expect(error.status).toBe(422);
  });

  it("never deletes the default branch", async () => {
    const error = (await deleteBranch(client(), DRAFTS.owner, DRAFTS.repo, "main").catch(
      (caught: unknown) => caught,
    )) as GithubError;
    expect(error.kind).toBe("unprocessable");
    expect(await listBranches(client(), DRAFTS.owner, DRAFTS.repo)).toContain("main");
  });
});

describe("API failures", () => {
  it("retries a 500 and then succeeds", async () => {
    server.state.failNext = 1;
    const client2 = new GithubClient({
      token: VALID,
      apiRoot: server.url,
      graphqlRoot: server.graphqlUrl,
      retryDelayMs: 0,
      maxRetries: 2,
    });
    await expect(getViewer(client2)).resolves.toMatchObject({ login: "owner" });
    expect(client2.calls).toBe(2);
  });

  it("gives up after the retry budget with a server error", async () => {
    server.state.failNext = 5;
    const error = (await getViewer(client()).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("server");
  });

  it("maps a rate limit to a distinct, actionable error", async () => {
    server.state.rateLimited = true;
    const error = (await getViewer(client()).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("rate_limited");
    expect(error.advice).toMatch(/rate limit/i);
  });

  it("reports an unreachable host as a network error, not a crash", async () => {
    const offline = new GithubClient({
      token: VALID,
      apiRoot: "http://127.0.0.1:1",
      graphqlRoot: "http://127.0.0.1:1/graphql",
      retryDelayMs: 0,
      maxRetries: 0,
    });
    const error = (await getViewer(offline).catch((caught: unknown) => caught)) as GithubError;
    expect(error.kind).toBe("network");
    expect(error.advice).toMatch(/network/i);
  });
});
