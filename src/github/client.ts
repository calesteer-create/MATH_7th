/**
 * Minimal GitHub REST + GraphQL client used by `npm run admin:verify-github`.
 *
 * The request shapes below are deliberately *not* invented: each one mirrors a
 * call Sveltia CMS actually makes (extracted from @sveltia/cms 0.262.1 — see
 * docs/ADMIN.md §4 for the extraction notes). The point of the verification
 * script is to exercise the same traffic against a real private repository, so
 * the client must speak Sveltia's dialect:
 *
 *   - `Authorization: token <PAT>`   (Sveltia's default authScheme is "token")
 *   - REST base  https://api.github.com
 *   - GraphQL    https://api.github.com/graphql  (POST {query, variables})
 *   - Blob bodies read with `Accept: application/vnd.github.raw`
 *   - Writes via the `createCommitOnBranch` GraphQL mutation with an
 *     `expectedHeadOid`, which is GitHub's optimistic-concurrency primitive —
 *     the whole reason two editors cannot silently overwrite each other.
 *
 * Error handling is part of the contract and is tested:
 *   - 401 → token invalid/expired
 *   - 403 → token valid but lacking permission, or rate limited
 *   - 404 → repository not visible to this token (this is what a private repo
 *           looks like to an unauthorised token) or the resource is missing
 *   - 409 / "expectedHeadOid does not match" → concurrent edit conflict
 *   - 422 → validation failure (e.g. ref already exists)
 * Nothing here stores, logs or returns the token.
 */

export const GITHUB_API_ROOT = "https://api.github.com";
export const GITHUB_GRAPHQL_ROOT = `${GITHUB_API_ROOT}/graphql`;

export type GithubErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "network"
  | "server"
  | "graphql";

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    readonly status: number,
    message: string,
    readonly detail: {
      /** Seconds until the rate limit resets, when known. */
      retryAfter?: number;
      /** GitHub's own message, when it supplied one. */
      apiMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = "GithubError";
  }

  /** Message a human should act on, never containing the token. */
  get advice(): string {
    switch (this.kind) {
      case "unauthorized":
        return "The token was rejected (401). It is invalid, expired or revoked — create a new fine-grained token.";
      case "forbidden":
        return "The token lacks the required permission (403). For fine-grained PATs it needs Contents: Read and write (and Metadata: Read, which GitHub adds automatically).";
      case "rate_limited":
        return "GitHub rate limit hit. Wait for the reset window, then re-run.";
      case "not_found":
        return "GitHub answered 404. For a private repository this means the token is not a member of it, or it was created for another account/resource owner. Check that the token's resource owner is the account that owns the repository.";
      case "conflict":
        return "The branch moved between read and write (expectedHeadOid mismatch). That is GitHub's concurrency guard working — reload and retry.";
      case "unprocessable":
        return "GitHub rejected the payload (422). Usually a ref that already exists or a validation rule.";
      case "graphql":
        return "The GraphQL API returned errors. Fine-grained tokens must be able to access the repository's GraphQL data.";
      default:
        return "Network or server error. Re-run; nothing was left half-written (the probe only writes on a scratch branch).";
    }
  }
}

export interface GithubClientOptions {
  token: string;
  /** Defaults to the public API. Overridable only for the test harness. */
  apiRoot?: string;
  graphqlRoot?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries for transient 5xx/429 responses. */
  maxRetries?: number;
  /** Milliseconds to wait between retries (tests pass 0). */
  retryDelayMs?: number;
}

export interface RestRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  /** Extra headers, e.g. Accept: application/vnd.github.raw */
  headers?: Record<string, string>;
  /** Return the raw text body instead of parsing JSON. */
  raw?: boolean;
  /** Treat 404 as an empty result instead of throwing. */
  allowNotFound?: boolean;
}

export class GithubClient {
  private readonly apiRoot: string;
  private readonly graphqlRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  /** Number of requests performed — the probe prints it as evidence. */
  calls = 0;

  constructor(private readonly options: GithubClientOptions) {
    this.apiRoot = (options.apiRoot ?? GITHUB_API_ROOT).replace(/\/$/, "");
    this.graphqlRoot = options.graphqlRoot ?? `${this.apiRoot}/graphql`;
    // Refuse to send a token over plain HTTP: Sveltia does the same and the
    // check belongs in the client, not only in the caller.
    if (!/^https?:\/\//i.test(this.apiRoot)) throw new Error("apiRoot must be an http(s) URL");
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(this.apiRoot);
    if (!this.apiRoot.startsWith("https://") && !isLocal) {
      throw new Error("refusing to send a token over an insecure connection");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1500;
  }

  /** Base REST path for a repository, identical to Sveltia's `pu()`. */
  repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async rest<T = unknown>(pathname: string, request: RestRequest = {}): Promise<T> {
    const url = `${this.apiRoot}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    return this.execute<T>(url, request);
  }

  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await this.execute<{ data?: T; errors?: Array<{ message?: string }> }>(
      this.graphqlRoot,
      { method: "POST", body: { query: query.replace(/\n\s*/g, " ").trim(), variables } },
    );
    if (response && Array.isArray(response.errors) && response.errors.length > 0) {
      const apiMessage = response.errors.map((e) => e.message ?? "unknown").join("; ");
      // GitHub reports a stale `expectedHeadOid` as a GraphQL error; it is a
      // concurrency conflict, not a protocol problem, so give it its own kind.
      const isStale = /expectedHeadOid|STALE_DATA/i.test(apiMessage);
      throw new GithubError(
        isStale ? "conflict" : "graphql",
        isStale ? 409 : 200,
        `GraphQL error: ${apiMessage}`,
        { apiMessage },
      );
    }
    if (!response || response.data === undefined) {
      throw new GithubError("graphql", 200, "GraphQL response had no data");
    }
    return response.data;
  }

  private async execute<T>(url: string, request: RestRequest, attempt = 0): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "math-7th-admin-probe",
      Authorization: `token ${this.options.token}`,
      ...request.headers,
    };
    const init: RequestInit = { method: request.method ?? "GET", headers, cache: "no-store" };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    this.calls += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new GithubError("network", 0, `could not reach GitHub: ${(error as Error).message}`);
    }

    if (!response.ok) {
      const text = await safeText(response);
      const apiMessage = extractMessage(text);
      const kind = classify(response.status, text, response.headers);
      if (kind === "not_found" && request.allowNotFound) {
        return undefined as T;
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? 0) || undefined;
      const transient = response.status >= 500 || kind === "rate_limited";
      if (transient && attempt < this.maxRetries) {
        if (this.retryDelayMs > 0) await sleep(this.retryDelayMs * (attempt + 1));
        return this.execute<T>(url, request, attempt + 1);
      }
      throw new GithubError(kind, response.status, `${response.status} ${kind}: ${apiMessage ?? text.slice(0, 200)}`, {
        retryAfter,
        apiMessage,
      });
    }

    if (request.raw) return (await response.text()) as unknown as T;
    const text = await response.text();
    if (text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}

function classify(status: number, body: string, headers: Headers): GithubErrorKind {
  const rateRemaining = headers.get("x-ratelimit-remaining");
  if ((status === 403 || status === 429) && (rateRemaining === "0" || /rate limit/i.test(body))) {
    return "rate_limited";
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "unprocessable";
  if (status >= 500) return "server";
  return "server";
}

function extractMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON */
  }
  return body.trim() ? body.trim().slice(0, 300) : undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Repository / branch helpers ────────────────────────────────────────── */

export interface RepoInfo {
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
  visibility?: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface RefInfo {
  ref: string;
  object: { sha: string; type: string };
}

export async function getRepo(
  client: GithubClient,
  owner: string,
  repo: string,
): Promise<RepoInfo> {
  return client.rest<RepoInfo>(client.repoPath(owner, repo));
}

export async function getViewer(client: GithubClient): Promise<{ login: string }> {
  return client.rest<{ login: string }>("/user");
}

/**
 * Sveltia's file listing: `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`.
 * A truncated tree is an error in Sveltia too ("too many files to list").
 */
export async function listTree(
  client: GithubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const response = await client.rest<{ tree?: TreeEntry[]; truncated?: boolean }>(
    `${client.repoPath(owner, repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  return { tree: response?.tree ?? [], truncated: response?.truncated === true };
}

/** Blob read as raw bytes-as-text, exactly like Sveltia's `Nq()`. */
export async function readBlob(
  client: GithubClient,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  return client.rest<string>(`${client.repoPath(owner, repo)}/git/blobs/${sha}`, {
    headers: { Accept: "application/vnd.github.raw" },
    raw: true,
  });
}

/** Commit object + file text in one GraphQL round trip (Sveltia's NLe shape). */
export async function readFileAtRef(
  client: GithubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const query = `query($owner: String!, $repo: String!, $expression: String!) {
      repository(owner: $owner, name: $repo) {
        object(expression: $expression) { ... on Blob { text isTruncated } }
      }
    }`;
  const data = await client.graphql<{
    repository?: { object?: { text?: string | null; isTruncated?: boolean } | null } | null;
  }>(query, { owner, repo, expression: `${ref}:${path}` });
  const object = data.repository?.object;
  if (!object) return null;
  return object.text ?? "";
}

/** Sveltia's branch-head lookup: `ref(qualifiedName){ target { ... on Commit { oid } } }`. */
export async function getBranchHead(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const query = `query($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        ref(qualifiedName: $branch) { target { ... on Commit { oid } } }
      }
    }`;
  const data = await client.graphql<{
    repository?: { ref?: { target?: { oid?: string } } | null } | null;
  }>(query, { owner, repo, branch });
  return data.repository?.ref?.target?.oid ?? null;
}

/**
 * Sveltia's permission probe before it allows editing a protected branch:
 * `ref(qualifiedName){ refUpdateRule { viewerCanPush } }`.
 */
export async function viewerCanPush(
  client: GithubClient,
  owner: string,
  repo: string,
  qualifiedName: string,
): Promise<boolean | null> {
  const query = `query($owner: String!, $repo: String!, $qualifiedName: String!) {
      repository(owner: $owner, name: $repo) {
        ref(qualifiedName: $qualifiedName) { refUpdateRule { viewerCanPush } }
      }
    }`;
  const data = await client.graphql<{
    repository?: { ref?: { refUpdateRule?: { viewerCanPush?: boolean } | null } | null } | null;
  }>(query, { owner, repo, qualifiedName });
  return data.repository?.ref?.refUpdateRule?.viewerCanPush ?? null;
}

export interface FileAddition {
  path: string;
  contents: string;
}

export interface FileDeletion {
  path: string;
}

export interface CommitResult {
  oid: string;
  committedDate: string;
}

/**
 * Sveltia's write path: `createCommitOnBranch` with `expectedHeadOid`.
 *
 * Using this mutation (rather than the Contents API) is what makes concurrent
 * edits safe: GitHub rejects the commit when the branch head moved since the
 * editor read it, surfacing a 409 instead of overwriting a colleague's save.
 */
export async function commitOnBranch(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
  expectedHeadOid: string,
  message: string,
  changes: { additions?: FileAddition[]; deletions?: FileDeletion[] },
): Promise<CommitResult> {
  const headLine = message.split(/\r?\n/)[0] ?? "Update";
  const bodyLine = message.split(/\r?\n/).slice(1).join(" ").trim();
  const input: Record<string, unknown> = {
    branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
    expectedHeadOid,
    message: bodyLine ? { headline: headLine, body: bodyLine } : { headline: headLine },
  };
  const fileChanges: Record<string, unknown> = {};
  if (changes.additions?.length) {
    fileChanges["additions"] = changes.additions.map((file) => ({
      path: file.path,
      contents: base64(file.contents),
    }));
  }
  if (changes.deletions?.length) {
    fileChanges["deletions"] = changes.deletions.map((file) => ({ path: file.path }));
  }
  input["fileChanges"] = fileChanges;

  const query = `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit { oid committedDate }
      }
    }`;
  const data = await client.graphql<{
    createCommitOnBranch?: { commit?: { oid?: string; committedDate?: string } } | null;
  }>(query, { input });
  const commit = data.createCommitOnBranch?.commit;
  if (!commit?.oid) throw new GithubError("graphql", 200, "createCommitOnBranch returned no commit");
  return { oid: commit.oid, committedDate: commit.committedDate ?? "" };
}

/** POST /git/refs — creates a branch pointing at an existing commit. */
export async function createBranch(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
): Promise<RefInfo> {
  return client.rest<RefInfo>(`${client.repoPath(owner, repo)}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

/** DELETE /git/refs/heads/<branch> — Sveltia's `wRe()` cleanup call. */
export async function deleteBranch(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  try {
    await client.rest<void>(
      `${client.repoPath(owner, repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: "DELETE" },
    );
    return true;
  } catch (error) {
    // 404 → the branch is already gone (idempotent cleanup).
    // 422 → GitHub refused (e.g. the default branch); that must surface loudly.
    if (error instanceof GithubError && error.kind === "not_found") return false;
    throw error;
  }
}

export async function listBranches(
  client: GithubClient,
  owner: string,
  repo: string,
): Promise<string[]> {
  const branches = await client.rest<Array<{ name: string }>>(
    `${client.repoPath(owner, repo)}/branches?per_page=100`,
  );
  return (branches ?? []).map((branch) => branch.name);
}

/** Classic tokens expose scopes in this header; fine-grained tokens do not. */
export function describeScopes(scopes: string | null): string {
  if (scopes === null) return "not reported (fine-grained token)";
  if (scopes.trim() === "") return "none";
  return scopes;
}

export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
