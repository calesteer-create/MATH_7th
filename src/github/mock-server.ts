/**
 * In-memory GitHub API simulator (PR 5 proof harness).
 *
 * ⚠ This is a SIMULATOR. It proves that our client speaks Sveltia's request
 * dialect and handles GitHub's documented error semantics; it does NOT prove
 * that Sveltia works against a real private repository. See docs/ADMIN.md
 * §"What was proven, simulated, and still unverified".
 *
 * What it implements faithfully:
 *   - `Authorization: token <PAT>`; missing/invalid → 401
 *   - private repositories are invisible (404) to tokens without access and to
 *     anonymous requests, exactly like GitHub
 *   - fine-grained permissions: `contents: read|write`, `pull_requests: read|write`
 *   - GraphQL: `repository.object(expression:"ref:path")`, `ref(qualifiedName)`,
 *     `createCommitOnBranch` with `expectedHeadOid` → conflict on mismatch
 *   - REST: /user, /repos/{o}/{r}, /git/trees/{ref}?recursive=1,
 *     /git/blobs/{sha} (raw + JSON), /git/refs (POST), /git/refs/heads/{b}
 *     (DELETE), /branches, /pulls, /issues/{n}/labels
 *   - rate limiting with `x-ratelimit-remaining: 0` → 403
 *   - deterministic 500s for testing retry behaviour
 *
 * It is a real HTTP server on 127.0.0.1 with an ephemeral port, so tests
 * exercise the same fetch/JSON path production uses.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

export interface Permissions {
  /** `none` = token exists but has no access to this repo. */
  contents: "none" | "read" | "write";
  pull_requests: "none" | "read" | "write";
  metadata: "read";
}

export interface MockToken {
  token: string;
  login: string;
  /** Resource owner the token belongs to (fine-grained tokens are per owner). */
  owner: string;
  permissions: Permissions;
  /** `classic` tokens expose x-oauth-scopes; fine-grained ones do not. */
  kind: "classic" | "fine-grained";
  scopes?: string;
  expired?: boolean;
}

export interface MockRepo {
  owner: string;
  name: string;
  private: boolean;
  /**
   * Lets a test make GitHub answer with a different `full_name` than the one
   * requested (a rename/redirect), to prove the write gate compares identity.
   */
  fullNameOverride?: string;
  defaultBranch: string;
  /** branch → path → utf8 content */
  branches: Map<string, Map<string, string>>;
  /** branch → head oid (simulated commit hashes) */
  heads: Map<string, string>;
  /** number of commits per branch, used for deterministic SHAs */
  commitCount: Map<string, number>;
  pullRequests: Array<{
    number: number;
    title: string;
    head: string;
    base: string;
    draft: boolean;
    body: string;
    labels: string[];
    state: "open" | "closed";
  }>;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  /** Never the token itself. */
  authenticated: boolean;
  /**
   * For `POST /graphql`, the operation GitHub was asked to run, classified as
   * `query` or `mutation`. Anything that can change state is a mutation, so
   * tests can assert "no write was attempted" without having to know every
   * operation name — and without treating `/graphql` as either always-read or
   * always-write.
   */
  graphqlOperation?: string;
  graphqlKind?: "query" | "mutation";
  /**
   * True only for requests that can modify state.
   *
   * - REST: any request whose HTTP method is `POST`, `PUT`, `PATCH` or `DELETE`.
   * - GraphQL: any request carrying an operation whose text is a `mutation`.
   *
   * `/graphql` is excluded from the REST rule on purpose: GraphQL always uses
   * POST, so a POST there may be a read (`query`) or a write (`mutation`), and
   * only the operation shape can tell them apart. An unrecognised mutation is
   * still a write (`unclassifiedMutation`), so no write can hide behind a name
   * the simulator does not know.
   */
  isWrite?: boolean;
}

export interface MockGithubState {
  tokens: MockToken[];
  repos: MockRepo[];
  requests: RequestLogEntry[];
  /** When > 0, the next N requests answer 500 (retry behaviour). */
  failNext: number;
  /** When true, every response carries x-ratelimit-remaining: 0. */
  rateLimited: boolean;
  /**
   * Simulates a token that can read the repository but whose Contents
   * permission is read-only: git ref endpoints answer 403 (writes) and
   * `GET /git/ref/…` answers 403 too, exactly as a narrow fine-grained token
   * behaves on some endpoints. Used to prove lookups never treat a 403 as
   * "branch absent".
   */
  denyRefReads?: boolean;
  /**
   * Models the ambiguity of GitHub's `permissions` block: the REST docs call it
   * "the permissions of the authenticated user", yet in practice it is computed
   * against the token's own rights. When true, the simulator reports the
   * *user's* repository access (so a read-only PAT still shows `push: true`),
   * which is the case the probe must not mistake for proof of write access.
   */
  reportUserPush?: boolean;
  /**
   * Runs after a request has been served, with the resolved repository (when the
   * path named one). Used by tests to change state *between* two calls — for
   * example flippnig a repository from private to public after the first
   * metadata read and before the write boundary.
   */
  afterRequest?: (entry: { method: string; path: string }, repoName: string | null) => void;
  /**
   * Deterministic failure injection: when it returns true, that request answers
   * 500 (before the retry budget is consumed). Used to fail one specific call
   * instead of "the next N requests".
   */
  failOn?: (entry: { method: string; path: string }) => boolean;
  /**
   * Makes `GET /branches` look complete while omitting some branches — the
   * "listing is not proof of absence" case. Keys are repository names.
   */
  truncateBranchListing?: string[];
}

const sha = (input: string): string => crypto.createHash("sha1").update(input).digest("hex");

export function createRepo(options: {
  owner: string;
  name: string;
  isPrivate: boolean;
  files?: Record<string, string>;
}): MockRepo {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const head = sha(`init:${options.owner}/${options.name}`);
  return {
    owner: options.owner,
    name: options.name,
    private: options.isPrivate,
    defaultBranch: "main",
    branches: new Map([["main", files]]),
    heads: new Map([["main", head]]),
    commitCount: new Map([["main", 1]]),
    pullRequests: [],
  };
}

function findRepo(state: MockGithubState, owner: string, name: string): MockRepo | undefined {
  return state.repos.find(
    (repo) =>
      repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase(),
  );
}

function normalizeToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^(?:token|bearer)\s+(.+)$/i.exec(raw.trim());
  return (match?.[1] ?? raw).trim();
}

function treeEntries(files: Map<string, string>): Array<{ path: string; type: string; sha: string; size: number }> {
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({
      path,
      type: "blob",
      sha: sha(content),
      size: Buffer.byteLength(content, "utf8"),
    }));
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function text(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function nextHead(commitCount: number, branch: string, parent: string, message: string): string {
  return sha(`${branch}:${parent}:${commitCount}:${message}`);
}

export interface MockGithubServer {
  url: string;
  graphqlUrl: string;
  state: MockGithubState;
  close(): Promise<void>;
  /**
   * Simulates a concurrent editor: moves the branch head without going through
   * the client, so the next `expectedHeadOid` write must fail with a conflict.
   */
  simulateConcurrentCommit(repoName: string, branch: string, path: string, content: string): string;
}

export async function startMockGithub(state: MockGithubState): Promise<MockGithubServer> {
  const server = http.createServer((req, res) => {
    void handle(state, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    graphqlUrl: `${url}/graphql`,
    state,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    simulateConcurrentCommit(repoName, branch, path, content) {
      const repo = state.repos.find((candidate) => candidate.name === repoName);
      if (!repo) throw new Error(`unknown repo ${repoName}`);
      const files = repo.branches.get(branch);
      if (!files) throw new Error(`unknown branch ${branch}`);
      files.set(path, content);
      const count = (repo.commitCount.get(branch) ?? 1) + 1;
      repo.commitCount.set(branch, count);
      const head = nextHead(count, branch, repo.heads.get(branch) ?? "", `concurrent:${path}`);
      repo.heads.set(branch, head);
      return head;
    },
  };
}

async function handle(state: MockGithubState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const rawToken = normalizeToken(req.headers.authorization as string | undefined);
  const entry: RequestLogEntry = {
    method: req.method ?? "GET",
    path: (req.url ?? "/").split("?")[0] ?? "/",
    status: 0,
    authenticated: rawToken !== undefined,
  };
  /* Every request is classified once, here. REST writes are decided by HTTP
     method; `/graphql` is decided by the operation shape further down, because
     GraphQL uses POST for both reads and writes. */
  entry.isWrite =
    entry.path !== "/graphql" && ["POST", "PUT", "PATCH", "DELETE"].includes(entry.method);
  const respond = (status: number, body: unknown, headers?: Record<string, string>, raw?: string): void => {
    entry.status = status;
    state.requests.push(entry);
    const extra: Record<string, string> = { ...headers };
    if (state.rateLimited) extra["x-ratelimit-remaining"] = "0";
    if (raw !== undefined) {
      text(res, status, raw, extra);
    } else {
      json(res, status, body, extra);
    }
    if (state.afterRequest) {
      const match = /^\/repos\/([^/]+)\/([^/]+)/.exec(entry.path);
      state.afterRequest({ method: entry.method, path: entry.path }, match?.[2] ?? null);
    }
  };

  const body = await readBody(req);

  if (state.failOn?.(entry)) {
    return respond(500, { message: "Server Error (simulated)" });
  }
  if (state.failNext > 0) {
    state.failNext -= 1;
    return respond(500, { message: "Server Error (simulated)" });
  }
  if (state.rateLimited) {
    return respond(403, { message: "API rate limit exceeded (simulated)" }, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
    });
  }

  const token = rawToken ? state.tokens.find((candidate) => candidate.token === rawToken) : undefined;
  if (!token) {
    return respond(401, { message: "Bad credentials" });
  }
  if (token.expired) {
    return respond(401, { message: "Bad credentials (token expired)" });
  }
  const scopeHeaders: Record<string, string> =
    token.kind === "classic" ? { "x-oauth-scopes": token.scopes ?? "repo" } : {};

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);

  /* ── /user ─────────────────────────────────────────────────────────────── */
  if (path === "/user" && req.method === "GET") {
    return respond(200, { login: token.login, id: 1, type: "User" }, scopeHeaders);
  }

  /* ── /graphql ──────────────────────────────────────────────────────────── */
  if (path === "/graphql" && req.method === "POST") {
    let payload: { query?: string; variables?: Record<string, unknown> };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return respond(400, { message: "Problems parsing JSON" });
    }
    const query = payload.query ?? "";
    const variables = payload.variables ?? {};
    const operation = detectOperation(query);
    const kind: "query" | "mutation" = /^\s*mutation\b|\bmutation\s*\(/.test(query)
      ? "mutation"
      : "query";
    entry.graphqlOperation = operation;
    entry.graphqlKind = kind;
    // GraphQL always uses POST, so the *shape* decides: a `query` is a read
    // even though it travels over POST; a `mutation` is a write — including an
    // operation this simulator does not recognise (`unclassifiedMutation`).
    entry.isWrite = kind === "mutation";
    if (kind === "mutation" && operation === "query") {
      // Defensive: a mutation must never be recorded as an anonymous "query".
      entry.graphqlOperation = "unclassifiedMutation";
    }

    // Resolve the repository named by the GraphQL variables, whatever the
    // operation is: mutations carry it inside `branch.repositoryNameWithOwner`.
    const inputBranch = ((variables["input"] ?? {}) as { branch?: { repositoryNameWithOwner?: string } })
      .branch;
    const named = typeof inputBranch?.repositoryNameWithOwner === "string"
      ? inputBranch.repositoryNameWithOwner.split("/")
      : null;
    const owner = String(named?.[0] ?? variables["owner"] ?? "");
    const repoName = String(named?.[1] ?? variables["repo"] ?? "");
    const scoped = /repository\(\s*owner:\s*\$owner,\s*name:\s*\$repo\s*\)/.test(query);
    if (!scoped && !query.includes("createCommitOnBranch")) {
      return respond(200, { errors: [{ message: "Unsupported simulation query" }] });
    }
    const repo = findRepo(state, owner, repoName);
    if (!repo || !canSee(repo, token)) {
      if (query.includes("createCommitOnBranch")) {
        return respond(200, { errors: [{ message: "Could not resolve to a Repository" }] }, scopeHeaders);
      }
      return respond(200, { data: { repository: null } }, scopeHeaders);
    }
    if (query.includes("createCommitOnBranch")) {
      // The commit mutation has no `repository(...)` field, so it is handled
      // before the repository-scoped queries below.
      if (!canWrite(repo, token)) {
        return respond(
          200,
          { errors: [{ message: "Resource not accessible by personal access token" }] },
          scopeHeaders,
        );
      }
      const input = (variables["input"] ?? {}) as {
        branch?: { branchName?: string };
        expectedHeadOid?: string;
        message?: { headline?: string; body?: string };
        fileChanges?: {
          additions?: Array<{ path: string; contents: string }>;
          deletions?: Array<{ path: string }>;
        };
      };
      const target = input.branch?.branchName ?? "";
      const targetFiles = repo.branches.get(target);
      if (!targetFiles) {
        return respond(200, { errors: [{ message: `Branch ${target} not found` }] }, scopeHeaders);
      }
      const current = repo.heads.get(target) ?? "";
      if (input.expectedHeadOid !== current) {
        return respond(
          200,
          {
            errors: [
              {
                message: `expectedHeadOid does not match the current branch head (expected ${input.expectedHeadOid}, actual ${current})`,
                type: "STALE_DATA",
              },
            ],
          },
          scopeHeaders,
        );
      }
      const additions = input.fileChanges?.additions ?? [];
      const deletions = input.fileChanges?.deletions ?? [];
      for (const addition of additions) {
        targetFiles.set(addition.path, Buffer.from(addition.contents, "base64").toString("utf8"));
      }
      for (const deletion of deletions) targetFiles.delete(deletion.path);
      const count = (repo.commitCount.get(target) ?? 1) + 1;
      repo.commitCount.set(target, count);
      const message = `${input.message?.headline ?? ""} ${input.message?.body ?? ""}`.trim();
      const oid = nextHead(count, target, current, message);
      repo.heads.set(target, oid);
      return respond(
        200,
        {
          data: {
            createCommitOnBranch: {
              commit: { oid, committedDate: new Date(1_760_000_000_000 + count * 1000).toISOString() },
            },
          },
        },
        scopeHeaders,
      );
    }

    if (token.permissions.contents === "none") {
      return respond(200, { data: { repository: null } }, scopeHeaders);
    }
    const qualifiedName = String(variables["qualifiedName"] ?? "");
    const branchName = String(
      variables["branch"] ?? (qualifiedName || repo.defaultBranch).replace(/^refs\/heads\//, ""),
    );
    const files = repo.branches.get(branchName);

    if (query.includes("defaultBranchRef")) {
      return respond(200, { data: { repository: { defaultBranchRef: { name: repo.defaultBranch } } } }, scopeHeaders);
    }
    if (query.includes("refUpdateRule")) {
      const target = qualifiedName.replace(/^refs\/heads\//, "");
      const canPush = canWrite(repo, token) && repo.branches.has(target);
      return respond(
        200,
        { data: { repository: { ref: { refUpdateRule: { viewerCanPush: canPush } } } } },
        scopeHeaders,
      );
    }
    if (query.includes("object(expression: $expression)")) {
      const expression = String(variables["expression"] ?? "");
      const [refPart, ...pathParts] = expression.split(":");
      const filePath = pathParts.join(":");
      const branchFiles = repo.branches.get(refPart ?? "");
      if (!branchFiles) return respond(200, { data: { repository: { object: null } } }, scopeHeaders);
      const content = branchFiles.get(filePath);
      if (content === undefined) return respond(200, { data: { repository: { object: null } } }, scopeHeaders);
      return respond(
        200,
        { data: { repository: { object: { text: content, isTruncated: false } } } },
        scopeHeaders,
      );
    }
    if (query.includes("ref(qualifiedName: $branch)")) {
      if (!files) return respond(200, { data: { repository: { ref: null } } }, scopeHeaders);
      return respond(
        200,
        { data: { repository: { ref: { target: { oid: repo.heads.get(branchName) ?? "" } } } } },
        scopeHeaders,
      );
    }
    return respond(200, { errors: [{ message: "Unsupported simulation query" }] }, scopeHeaders);
  }

  /* ── REST: /repos/{owner}/{repo}[/…] ───────────────────────────────────── */
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!repoMatch) {
    if (path.startsWith("/repos/")) return respond(404, { message: "Not Found" });
    return respond(404, { message: "Not Found" });
  }
  const [, ownerRaw, nameRaw, rest = ""] = repoMatch;
  const repo = findRepo(state, ownerRaw ?? "", nameRaw ?? "");
  if (!repo || !canSee(repo, token)) {
    // Private repo + unauthorised token → 404, never 403 (no existence leak).
    return respond(404, { message: "Not Found" }, scopeHeaders);
  }

  if (rest === "" && req.method === "GET") {
    return respond(
      200,
      {
        full_name: repo.fullNameOverride ?? `${repo.owner}/${repo.name}`,
        private: repo.private,
        default_branch: repo.defaultBranch,
        visibility: repo.private ? "private" : "public",
        permissions: {
          admin: canWrite(repo, token),
          maintain: canWrite(repo, token),
          // Two different questions, deliberately separable in the simulator.
          push: state.reportUserPush
            ? canSee(repo, token) && token.owner.toLowerCase() === repo.owner.toLowerCase()
            : canWrite(repo, token),
          pull: token.permissions.contents !== "none",
        },
      },
      scopeHeaders,
    );
  }

  const treeMatch = /^\/git\/trees\/([^/?]+)(\?.*)?$/.exec(rest);
  if (treeMatch && req.method === "GET") {
    if (token.permissions.contents === "none") return respond(404, { message: "Not Found" }, scopeHeaders);
    const ref = treeMatch[1] ?? "";
    const files = repo.branches.get(ref);
    if (!files) return respond(404, { message: "Not Found" }, scopeHeaders);
    return respond(200, { sha: repo.heads.get(ref), tree: treeEntries(files), truncated: false }, scopeHeaders);
  }

  const blobMatch = /^\/git\/blobs\/([^/?]+)$/.exec(rest);
  if (blobMatch && req.method === "GET") {
    if (token.permissions.contents === "none") return respond(404, { message: "Not Found" }, scopeHeaders);
    const wanted = blobMatch[1];
    const accept = String(req.headers.accept ?? "");
    for (const files of repo.branches.values()) {
      for (const content of files.values()) {
        if (sha(content) !== wanted) continue;
        if (accept.includes("application/vnd.github.raw")) {
          entry.status = 200;
          state.requests.push(entry);
          return text(res, 200, content, { ...scopeHeaders });
        }
        return respond(
          200,
          { sha: wanted, size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64"), encoding: "base64" },
          scopeHeaders,
        );
      }
    }
    return respond(404, { message: "Not Found" }, scopeHeaders);
  }

  if (rest === "/git/refs" && req.method === "POST") {
    if (!canWrite(repo, token)) {
      return respond(403, { message: "Resource not accessible by personal access token" }, scopeHeaders);
    }
    const parsed = JSON.parse(body || "{}") as { ref?: string; sha?: string };
    const branch = (parsed.ref ?? "").replace(/^refs\/heads\//, "");
    if (!branch) return respond(422, { message: "Invalid ref" }, scopeHeaders);
    if (repo.branches.has(branch)) {
      return respond(422, { message: "Reference already exists" }, scopeHeaders);
    }
    const baseFiles = [...repo.branches.values()][0] ?? new Map<string, string>();
    // Copy the branch's content from its base commit when we know it.
    const sourceBranch = [...repo.heads.entries()].find(([, oid]) => oid === parsed.sha)?.[0];
    const files = new Map(sourceBranch ? repo.branches.get(sourceBranch) ?? baseFiles : baseFiles);
    repo.branches.set(branch, files);
    repo.heads.set(branch, parsed.sha ?? "");
    repo.commitCount.set(branch, 1);
    return respond(201, { ref: `refs/heads/${branch}`, object: { sha: parsed.sha ?? "", type: "commit" } }, scopeHeaders);
  }

  /* GET /git/ref/heads/{branch} — exact single-ref lookup (no pagination). */
  const exactRefMatch = /^\/git\/ref\/heads\/([^/?]+)$/.exec(rest);
  if (exactRefMatch && req.method === "GET") {
    if (state.denyRefReads) {
      return respond(403, { message: "Resource not accessible by personal access token" }, scopeHeaders);
    }
    const branch = exactRefMatch[1] ?? "";
    if (!repo.branches.has(branch)) return respond(404, { message: "Not Found" }, scopeHeaders);
    return respond(
      200,
      {
        ref: `refs/heads/${branch}`,
        object: { sha: repo.heads.get(branch) ?? "", type: "commit" },
      },
      scopeHeaders,
    );
  }

  const deleteRefMatch = /^\/git\/refs\/heads\/([^/?]+)$/.exec(rest);
  if (deleteRefMatch && req.method === "DELETE") {
    if (!canWrite(repo, token)) {
      return respond(403, { message: "Resource not accessible by personal access token" }, scopeHeaders);
    }
    const branch = deleteRefMatch[1] ?? "";
    if (branch === repo.defaultBranch) {
      return respond(422, { message: "Cannot delete the default branch" }, scopeHeaders);
    }
    if (!repo.branches.has(branch)) return respond(404, { message: "Not Found" }, scopeHeaders);
    repo.branches.delete(branch);
    repo.heads.delete(branch);
    repo.commitCount.delete(branch);
    res.writeHead(204, scopeHeaders);
    entry.status = 204;
    state.requests.push(entry);
    res.end();
    return;
  }

  if (rest.startsWith("/branches") && req.method === "GET") {
    const hidden = (state.truncateBranchListing ?? []).includes(repo.name);
    return respond(
      200,
      [...repo.branches.keys()]
        .filter((name) => !(hidden && name.startsWith("admin-verification")))
        .map((name) => ({ name })),
      scopeHeaders,
    );
  }

  if (rest === "/pulls" && req.method === "POST") {
    if (!canWrite(repo, token) || token.permissions.pull_requests === "none") {
      return respond(403, { message: "Resource not accessible by personal access token" }, scopeHeaders);
    }
    const parsed = JSON.parse(body || "{}") as { title?: string; head?: string; base?: string; draft?: boolean; body?: string };
    const number = repo.pullRequests.length + 1;
    const pr = {
      number,
      title: parsed.title ?? "",
      head: parsed.head ?? "",
      base: parsed.base ?? repo.defaultBranch,
      draft: parsed.draft === true,
      body: parsed.body ?? "",
      labels: [] as string[],
      state: "open" as const,
    };
    repo.pullRequests.push(pr);
    return respond(
      201,
      { number, title: pr.title, head: { ref: pr.head }, base: { ref: pr.base }, draft: pr.draft, node_id: `PR_${number}` },
      scopeHeaders,
    );
  }

  const labelMatch = /^\/issues\/(\d+)\/labels$/.exec(rest);
  if (labelMatch && req.method === "POST") {
    if (token.permissions.pull_requests === "none") {
      return respond(403, { message: "Resource not accessible by personal access token" }, scopeHeaders);
    }
    const parsed = JSON.parse(body || "{}") as { labels?: string[] };
    const pr = repo.pullRequests.find((candidate) => candidate.number === Number(labelMatch[1]));
    if (!pr) return respond(404, { message: "Not Found" }, scopeHeaders);
    for (const label of parsed.labels ?? []) if (!pr.labels.includes(label)) pr.labels.push(label);
    return respond(200, pr.labels.map((name) => ({ name })), scopeHeaders);
  }

  return respond(404, { message: "Not Found" }, scopeHeaders);
}

function detectOperation(query: string): string {
  if (query.includes("createCommitOnBranch")) return "createCommitOnBranch";
  if (query.includes("createRef")) return "createRef";
  if (query.includes("deleteRef")) return "deleteRef";
  if (query.includes("refUpdateRule")) return "viewerCanPush";
  if (query.includes("defaultBranchRef")) return "defaultBranch";
  if (query.includes("object(expression")) return "readFile";
  if (query.includes("ref(qualifiedName")) return "branchHead";
  // Never silently "other" for a mutation: an unclassified mutation would be a
  // write nobody noticed.
  return /^\s*mutation\b/.test(query) ? "unclassifiedMutation" : "query";
}

function canSee(repo: MockRepo, token: MockToken): boolean {
  if (!repo.private) return true;
  // A fine-grained token sees only repositories of its own resource owner.
  if (token.owner.toLowerCase() !== repo.owner.toLowerCase()) return false;
  return token.permissions.contents !== "none";
}

function canWrite(repo: MockRepo, token: MockToken): boolean {
  if (!canSee(repo, token)) return false;
  return token.permissions.contents === "write";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

export interface FixtureOptions {
  /** A reasonably complete private drafts repository. */
  files?: Record<string, string>;
}

export const SAMPLE_LESSON = JSON.stringify(
  {
    id: 1,
    unitId: 1,
    position: 1,
    titleAr: "مثال مرجعي — درس في مستودع المسودات",
    titleEn: "Reference example — draft repository lesson",
    pageLabel: "ص 1",
    status: "draft",
    isLastInUnit: false,
    publishedAt: null,
    contentUpdatedAt: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    images: [],
  },
  null,
  2,
);

/**
 * A fixture shaped like `defaultFixture()` with extra repositories appended and
 * selected tokens that keep access to them. Used by the safety tests to model
 * "a public repository with a different name", "a private repo that GitHub
 * reports oddly", etc.
 */
export function fixtureWithRepos(options: {
  repos?: Array<{ owner: string; name: string; isPrivate: boolean; files?: Record<string, string> }>;
}): MockGithubState {
  const state = defaultFixture();
  const extra = (options.repos ?? []).filter(
    (candidate) =>
      !state.repos.some(
        (repo) =>
          repo.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          repo.name.toLowerCase() === candidate.name.toLowerCase(),
      ),
  );
  for (const candidate of extra) {
    state.repos.push(
      createRepo({
        owner: candidate.owner,
        name: candidate.name,
        isPrivate: candidate.isPrivate,
        files: candidate.files ?? { "content/README.md": "# fixture\n" },
      }),
    );
  }
  return state;
}

export function defaultFixture(options: FixtureOptions = {}): MockGithubState {
  const files: Record<string, string> = {
    "content/README.md": "# drafts\n",
    "public/admin/config.yml": "backend:\n  name: github\n",
    ...(options.files ?? {}),
  };
  return {
    tokens: [
      {
        token: "ghp_valid_classic_repo_scope",
        login: "owner",
        owner: "calesteer-create",
        kind: "classic",
        scopes: "repo",
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
      {
        token: "github_pat_finegrained_contents_write",
        login: "owner",
        owner: "calesteer-create",
        kind: "fine-grained",
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
      {
        token: "github_pat_finegrained_contents_read",
        login: "owner",
        owner: "calesteer-create",
        kind: "fine-grained",
        permissions: { contents: "read", pull_requests: "read", metadata: "read" },
      },
      {
        token: "github_pat_finegrained_no_contents",
        login: "owner",
        owner: "calesteer-create",
        kind: "fine-grained",
        permissions: { contents: "none", pull_requests: "none", metadata: "read" },
      },
      {
        token: "github_pat_other_owner",
        login: "stranger",
        owner: "some-other-account",
        kind: "fine-grained",
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
      {
        token: "github_pat_expired",
        login: "owner",
        owner: "calesteer-create",
        kind: "fine-grained",
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        expired: true,
      },
    ],
    repos: [
      createRepo({ owner: "calesteer-create", name: "MATH_7th-drafts", isPrivate: true, files }),
      createRepo({
        owner: "calesteer-create",
        name: "MATH_7th",
        isPrivate: false,
        files: { "README.md": "# public\n" },
      }),
    ],
    requests: [],
    failNext: 0,
    rateLimited: false,
  };
}
