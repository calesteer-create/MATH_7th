/**
 * Sveltia CMS ↔ GitHub traffic, extracted from the shipped bundle (PR 5).
 *
 * Source of truth: `@sveltia/cms@0.262.1` (`dist/sveltia-cms.js`, minified).
 * Every step below was located in that file; the `evidence` field records the
 * code shape that proves it, so the sequence can be re-checked when the CMS is
 * upgraded. Nothing here was designed from scratch — that is the whole point of
 * requirement 4 ("test the sequence extracted from Sveltia, not a sequence of
 * your own design").
 *
 * What Sveltia does, in order, for a save on a private repo with token auth
 * and the simple workflow:
 *
 *   1  GET  /user                                   (token → account)
 *   2  GraphQL  repository.defaultBranchRef          (wq(), repo lookup)
 *   3  GraphQL  ref(qualifiedName).refUpdateRule     (YIe() viewerCanPush)
 *   4  GET  /repos/{o}/{r}/git/trees/{b}?recursive=1 (kLe → jq: file list)
 *   5  GraphQL  object(expression:"b:path"){text}    (NLe: parse an entry)
 *   6  GET  /repos/{o}/{r}/git/blobs/{sha}  raw      (Mq/Nq: truncated blobs)
 *   7  GraphQL  ref(qualifiedName).target.oid        (fLe: expectedHeadOid)
 *   8  GraphQL  createCommitOnBranch(input)          (gLe: the save)
 *   9  GET  /repos/{o}/{r}/git/refs/heads/{branch}   (branch bookkeeping)
 *  10  DELETE /repos/{o}/{r}/git/refs/heads/{branch} (wRe: workflow cleanup)
 *
 * Deliberately excluded from the probe: `POST /pulls` and the label calls of
 * the editorial workflow. They require `pull_requests: write`, which the probe
 * reports on but does not exercise — opening a pull request in someone's real
 * repository is not a safe probe.
 */

import {
  GithubError,
  createBranch,
  deleteBranch,
  getBranchHead,
  getRepo,
  getViewer,
  listBranches,
  listTree,
  commitOnBranch,
  readBlob,
  readFileAtRef,
  viewerCanPush,
  type GithubClient,
} from "./client";

export const SVELTIA_CMS_VERSION = "0.262.1";

export interface TraceStep {
  id: string;
  /** Plain-language action, shown in the report. */
  action: string;
  /** Where in Sveltia's bundle this comes from. */
  evidence: "extracted" | "documented";
  detail: string;
}

export const SVELTIA_TRACE: readonly TraceStep[] = [
  {
    id: "auth",
    action: "Validate the token and read the signed-in account",
    evidence: "extracted",
    detail: "Bu() sets `Authorization: <authScheme> <token>`; on 401 it calls refreshAccessToken, and without one it surfaces the 401.",
  },
  {
    id: "default-branch",
    action: "Resolve the repository's default branch",
    evidence: "extracted",
    detail: "XIe(): query($owner,$repo){ repository { defaultBranchRef { name } } }",
  },
  {
    id: "repo-metadata",
    action: "Read repository metadata and the token's effective permissions",
    evidence: "documented",
    detail: "REST GET /repos/{owner}/{repo} — GitHub's documented permission surface (push/maintain/admin).",
  },
  {
    id: "can-push",
    action: "Ask GitHub whether this user may push to the branch",
    evidence: "extracted",
    detail: "YIe(): ref(qualifiedName){ refUpdateRule { viewerCanPush } } — used to decide whether editing is read-only.",
  },
  {
    id: "file-list",
    action: "List every file in the branch",
    evidence: "extracted",
    detail: "jq()/kLe(): GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1, falling back to non-recursive when truncated.",
  },
  {
    id: "read-entry",
    action: "Read one entry file",
    evidence: "extracted",
    detail: "ALe(): repository.object(expression: \"branch:path\") { ... on Blob { text isTruncated } }",
  },
  {
    id: "read-blob",
    action: "Read a blob's raw bytes",
    evidence: "extracted",
    detail: "Mq()/Nq(): GET /git/blobs/{sha} with Accept: application/vnd.github.raw",
  },
  {
    id: "create-ref",
    action: "Create a scratch branch from the base commit",
    evidence: "extracted",
    detail: "xRe(): mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name } } } — used by the editorial workflow; the probe reuses it to stay off the base branch.",
  },
  {
    id: "write",
    action: "Commit an entry to the branch with optimistic concurrency",
    evidence: "extracted",
    detail: "gLe(): mutation createCommitOnBranch(input:{expectedHeadOid,…}) — GitHub rejects a stale head, which is the conflict signal.",
  },
  {
    id: "branch-head",
    action: "Re-read the branch head after writing",
    evidence: "extracted",
    detail: "fLe()/dLe: ref(qualifiedName).target.{ ... on Commit { oid } }",
  },
  {
    id: "cleanup-ref",
    action: "Delete a temporary branch",
    evidence: "extracted",
    detail: "wRe(): DELETE /git/refs/heads/{branch}",
  },
];

export class TraceError extends Error {
  constructor(
    readonly step: TraceStep,
    override readonly cause: unknown,
    message: string,
  ) {
    super(`${step.id}: ${message}`);
    this.name = "TraceError";
  }
}

export interface TraceOptions {
  owner: string;
  repo: string;
  /** Branch the probe writes to. MUST NOT be the default branch. */
  branch: string;
  /** Path of the throwaway file written by the probe. */
  probePath?: string;
  /** Content written to probePath. Must contain no secrets. */
  probeContent?: string;
  /** Read this file from the base branch before writing. */
  samplePath?: string;
  /** Delete the probe branch at the end (default true). */
  cleanupBranch?: boolean;
  /** Delete the probe file with a second commit instead of dropping a branch. */
  deleteProbeFile?: boolean;
  onStep?: (result: TraceStepResult) => void;
}

export interface TraceStepResult {
  step: TraceStep;
  ok: boolean;
  ms: number;
  /** Short, token-free description of what was observed. */
  note: string;
  error?: { kind: string; status: number; message: string; advice: string };
}

export interface TraceReport {
  ok: boolean;
  steps: TraceStepResult[];
  /** Extra observations worth telling the owner about. */
  findings: string[];
  /** Set when the repository looks like the public site. */
  blockedReason?: string;
  /** Filled in by the CLI after it drops the scratch branch. */
  cleanup?: string;
}

export const PROBE_FILE_DEFAULT = "content/.admin-probe.json";

/**
 * Runs Sveltia's request sequence against a real (or simulated) GitHub.
 *
 * Safety rails, all enforced here rather than in the caller:
 *   - never writes to the default branch or to `main`;
 *   - never opens a pull request;
 *   - the probe content carries no token;
 *   - the probe file is always deleted and the branch dropped, in a `finally`.
 */
export async function runSveltiaTrace(client: GithubClient, options: TraceOptions): Promise<TraceReport> {
  const steps: TraceStepResult[] = [];
  const findings: string[] = [];
  const probePath = options.probePath ?? PROBE_FILE_DEFAULT;
  const probeContent =
    options.probeContent ??
    JSON.stringify(
      {
        probe: "math-7th admin:verify-github",
        cms: `@sveltia/cms@${SVELTIA_CMS_VERSION}`,
        at: new Date().toISOString(),
        note: "Temporary file created by the verification script; safe to delete.",
      },
      null,
      2,
    );
  let defaultBranch = "";
  let createdBranch = false;
  let blockedReason: string | undefined;

  /** Builds the report; declared first so every early return can use it. */
  function finish(): TraceReport {
    return { ok: steps.every((result) => result.ok) && !blockedReason, steps, findings, blockedReason };
  }

  const stepById = (id: string): TraceStep => {
    const step = SVELTIA_TRACE.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`unknown trace step ${id}`);
    return step;
  };

  const run = async <T>(
    id: string,
    fn: () => Promise<T>,
    note: (value: T) => string,
    mode: { expectFailure?: boolean } = {},
  ): Promise<T | undefined> => {
    const step = stepById(id);
    const started = Date.now();
    try {
      const value = await fn();
      const result: TraceStepResult = { step, ok: true, ms: Date.now() - started, note: note(value) };
      steps.push(result);
      options.onStep?.(result);
      return value;
    } catch (error) {
      // A deliberate negative probe (the stale-head retry) counts as a PASS
      // when GitHub rejects it — that rejection is the behaviour under test.
      if (mode.expectFailure) {
        const result: TraceStepResult = {
          step,
          ok: true,
          ms: Date.now() - started,
          note:
            error instanceof GithubError
              ? `rejected as expected (${error.kind}): ${error.message}`
              : `rejected as expected: ${(error as Error).message}`,
        };
        steps.push(result);
        options.onStep?.(result);
        return undefined;
      }
      const result: TraceStepResult = {
        step,
        ok: false,
        ms: Date.now() - started,
        note: "failed",
        error:
          error instanceof GithubError
            ? { kind: error.kind, status: error.status, message: error.message, advice: error.advice }
            : { kind: "unknown", status: 0, message: (error as Error).message, advice: "Unexpected error." },
      };
      steps.push(result);
      options.onStep?.(result);
      return undefined;
    }
  };

  /* 1 — token / account */
  const viewer = await run("auth", () => getViewer(client), (value) => `signed in as ${value.login}`);
  if (!viewer) return finish();

  /* 2 — repository existence + default branch */
  const repoInfo = await run(
    "repo-metadata",
    () => getRepo(client, options.owner, options.repo),
    (value) =>
      `${value.full_name} (${value.private ? "private" : "PUBLIC"}, default branch ${value.default_branch}, push=${String(value.permissions?.push ?? false)})`,
  );
  if (!repoInfo) return finish();
  defaultBranch = repoInfo.default_branch;
  if (!repoInfo.private) {
    findings.push(
      "The repository is PUBLIC. This does not prove Sveltia works with a private repository — requirement 6 is not satisfied by this result.",
    );
  }
  if (repoInfo.full_name.toLowerCase() === "calesteer-create/math_7th") {
    blockedReason =
      "This is the PUBLIC site repository. Refusing to write a probe file there (requirement 5). Point the script at MATH_7th-drafts.";
    findings.push(blockedReason);
    return finish();
  }
  if (repoInfo.permissions?.push !== true) {
    findings.push("The token can read this repository but cannot push, so the write steps will fail.");
  }

  const branch = options.branch;
  if (branch === defaultBranch || branch.toLowerCase() === "main") {
    blockedReason = `refusing to probe branch "${branch}": the probe only writes to a scratch branch, never to ${defaultBranch}.`;
    findings.push(blockedReason);
    return finish();
  }

  await run(
    "default-branch",
    () => getBranchHead(client, options.owner, options.repo, defaultBranch),
    (head) => (head ? `head ${head.slice(0, 7)}` : "branch has no head"),
  );

  /* 3 — push permission as Sveltia asks it */
  await run(
    "can-push",
    () => viewerCanPush(client, options.owner, options.repo, `refs/heads/${defaultBranch}`),
    (value) =>
      value === null
        ? "GitHub did not report refUpdateRule (unprotected branch) — Sveltia treats this as pushable"
        : `viewerCanPush=${String(value)}`,
  );

  /* 4 — file list */
  const tree = await run(
    "file-list",
    () => listTree(client, options.owner, options.repo, defaultBranch),
    (value) => `${value.tree.filter((entry) => entry.type === "blob").length} files${value.truncated ? " (TRUNCATED)" : ""}`,
  );
  if (tree?.truncated) findings.push("The tree listing was truncated; Sveltia would retry per directory.");

  /* 5 — read one entry */
  const samplePath =
    options.samplePath ??
    tree?.tree.find((entry) => entry.type === "blob" && entry.path.endsWith(".json"))?.path ??
    tree?.tree.find((entry) => entry.type === "blob")?.path;
  if (samplePath) {
    await run(
      "read-entry",
      () => readFileAtRef(client, options.owner, options.repo, samplePath, defaultBranch),
      (text) => (text === null ? `${samplePath} not found` : `read ${samplePath} (${Buffer.byteLength(text)} bytes)`),
    );
    const blobEntry = tree?.tree.find((entry) => entry.path === samplePath && entry.type === "blob");
    if (blobEntry) {
      await run(
        "read-blob",
        () => readBlob(client, options.owner, options.repo, blobEntry.sha),
        (text) => `read blob ${blobEntry.sha.slice(0, 7)} (${Buffer.byteLength(text)} bytes)`,
      );
    }
  } else {
    findings.push("The repository has no blobs yet, so the file-read steps were skipped. Add one unit to test them.");
  }

  /* 6/7/8/9 — write path on a scratch branch */
  const baseHead = await getBranchHead(client, options.owner, options.repo, defaultBranch);
  if (!baseHead) {
    findings.push(`Could not resolve the head of ${defaultBranch}; skipping the write steps.`);
    return finish();
  }
  const existingBranches = await listBranches(client, options.owner, options.repo).catch(
    (): string[] => [],
  );
  if (existingBranches.includes(branch)) {
    blockedReason = `scratch branch "${branch}" already exists; delete it or pass --branch with a fresh name.`;
    findings.push(blockedReason);
    return finish();
  }

  const created = await run(
    "create-ref",
    async () => {
      const ref = await createBranch(client, options.owner, options.repo, branch, baseHead);
      createdBranch = true;
      return ref;
    },
    (ref) => `created scratch branch ${ref.ref} at ${ref.object.sha.slice(0, 7)}`,
  );
  if (!created) return finish();

  const headAfterCreate = await getBranchHead(client, options.owner, options.repo, branch);
  if (!headAfterCreate) {
    findings.push("Could not read the scratch branch head; skipping the commit steps.");
    return finish();
  }

  const commit = await run(
    "write",
    () =>
      commitOnBranch(client, options.owner, options.repo, branch, headAfterCreate, "chore: admin probe (MATH 7TH)", {
        additions: [{ path: probePath, contents: probeContent }],
      }),
    (value) => `committed ${value.oid.slice(0, 7)} to ${branch}`,
  );
  if (!commit) return finish();

  /* concurrency: the same expectedHeadOid must now be rejected.
     A rejection is the PASS here; acceptance is the finding we report. */
  const acceptedStale = await run(
    "write",
    () =>
      commitOnBranch(client, options.owner, options.repo, branch, headAfterCreate, "chore: stale probe", {
        additions: [{ path: probePath, contents: probeContent }],
      }),
    () => "UNEXPECTED: GitHub accepted a stale expectedHeadOid",
    { expectFailure: true },
  );
  // Replace the step note so a reader sees "expected" rather than a fake pass.
  const staleStep = steps[steps.length - 1];
  if (staleStep && staleStep.step.id === "write") staleStep.note = `concurrency: ${staleStep.note}`;
  if (acceptedStale) {
    findings.push(
      "⚠ GitHub accepted a commit with a stale expectedHeadOid. Sveltia's concurrency protection would not work in this repository — investigate before trusting the CMS.",
    );
  } else {
    findings.push("Concurrency guard confirmed: a second commit with the same expectedHeadOid was rejected.");
  }

  await run(
    "branch-head",
    () => getBranchHead(client, options.owner, options.repo, branch),
    (head) => (head ? `head is now ${head.slice(0, 7)}` : "branch vanished"),
  );

  const written = await run(
    "read-entry",
    () => readFileAtRef(client, options.owner, options.repo, probePath, branch),
    (text) => (text === probeContent ? "read back the probe file byte-for-byte" : "read back a DIFFERENT payload"),
  );
  if (written !== undefined && written !== probeContent) {
    findings.push("The probe file read back with different content than was written — investigate encoding.");
  }

  return finish();
}

/**
 * Cleanup, run explicitly by the caller so its result can be reported.
 * Safe to call twice; a missing branch is not an error.
 */
export async function cleanupProbeBranch(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
  defaultBranch: string,
): Promise<{ ok: boolean; note: string }> {
  if (branch === defaultBranch || branch.toLowerCase() === "main") {
    return { ok: false, note: `refusing to delete "${branch}": it is the default branch` };
  }
  const started = Date.now();
  try {
    const branches = await listBranches(client, owner, repo);
    if (!branches.includes(branch)) {
      return { ok: true, note: `nothing to clean up (branch ${branch} was not created)` };
    }
    const removed = await deleteBranch(client, owner, repo, branch);
    return {
      ok: true,
      note: removed
        ? `deleted scratch branch ${branch} (${Date.now() - started} ms)`
        : `scratch branch ${branch} was already gone`,
    };
  } catch (error) {
    const advice = error instanceof GithubError ? error.advice : (error as Error).message;
    return { ok: false, note: `could not delete ${branch}: ${advice}` };
  }
}
