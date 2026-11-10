/**
 * Repository write guard (PR 5 requirement 5/10).
 *
 * Every code path in this PR that generates a CMS config or writes content has
 * to pass through this module. There are exactly two layers, and the second
 * one can never be skipped by an environment variable:
 *
 *   1  **Static destination check** — the target must be the one destination
 *      agreed for drafts, `calesteer-create/MATH_7th-drafts`, and must not be
 *      the public site repository. This runs offline, so it protects the
 *      committed `public/admin/config.yml` and the shipped panel. A name is
 *      never treated as proof that a repository is private; `DRAFT_REPO` can
 *      no longer point the CMS anywhere else.
 *
 *   2  **Live visibility check** — before anything is written to GitHub, the
 *      caller must hand GitHub's own answer to `checkWritableRepo()`. Draft
 *      content is published the moment it lands in a public repository, so the
 *      only acceptable answer is a literal `private === true`. Missing, null
 *      or non-boolean values all count as "not private".
 *
 * The verification CLI is the only thing allowed to look at a repository other
 * than the agreed destination, and only in read-only "inspect" mode unless the
 * live checks pass (see `verifyWritePreconditions`).
 */

export const PUBLIC_REPO = "calesteer-create/MATH_7th";
/** The single destination drafts may ever be written to (name fixed by design). */
export const DRAFT_REPO_DEFAULT = "calesteer-create/MATH_7th-drafts";
export const DRAFT_BRANCH = "main";
export const DRAFT_REPO_ENV = "DRAFT_REPO";

export type RepoRole = "public" | "draft" | "foreign";

/** `owner/name`, both segments limited to what GitHub actually allows. */
const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export interface TargetResolution {
  repo: string;
  role: RepoRole;
  /** Non-empty when the target must not be written to. */
  problem: string | null;
  /**
   * True only for the agreed drafts destination, whose configured role implies
   * PRIVATE. This is *not* a live visibility check: it says the destination is
   * the agreed one, and the live check still runs before any write. A renamed
   * or foreign repository is always `false`, because static code cannot prove
   * a repository private.
   */
  privacyProvable: boolean;
}

export function normalizeRepo(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
}

export function classifyRepo(value: string): RepoRole {
  const repo = normalizeRepo(value).toLowerCase();
  if (repo === PUBLIC_REPO.toLowerCase()) return "public";
  if (repo === DRAFT_REPO_DEFAULT.toLowerCase()) return "draft";
  return "foreign";
}

/** Case/`.git`/trailing-slash-insensitive equality of two `owner/name` values. */
export function isSameRepo(a: string, b: string): boolean {
  return normalizeRepo(a).toLowerCase() === normalizeRepo(b).toLowerCase();
}

/**
 * Resolves the drafts destination for the CMS generator.
 *
 * Only the agreed destination is accepted. `DRAFT_REPO` may restate it (case,
 * `.git`, trailing slash are normalised away), but any other value is refused:
 * changing the drafts destination requires a code change plus a live private-
 * repository check, not an environment variable.
 */
export function resolveDraftRepo(env: Record<string, string | undefined> = {}): TargetResolution {
  const requested = env[DRAFT_REPO_ENV];
  const repo = normalizeRepo(requested && requested.trim() ? requested : DRAFT_REPO_DEFAULT);
  if (!REPO_RE.test(repo)) {
    return {
      repo,
      role: "foreign",
      problem: `${DRAFT_REPO_ENV} must look like "owner/name", got ${JSON.stringify(requested)}`,
      privacyProvable: false,
    };
  }
  const role = classifyRepo(repo);
  if (role === "public") {
    return {
      repo,
      role,
      problem:
        `${repo} is the PUBLIC repository — draft edits must never be written there ` +
        `(requirement 5). Point ${DRAFT_REPO_ENV} at the private drafts repository instead.`,
      privacyProvable: false,
    };
  }
  if (role === "foreign") {
    return {
      repo,
      role,
      problem:
        `${repo} is not the agreed drafts destination (${DRAFT_REPO_DEFAULT}). ` +
        `The CMS config is generated only for ${DRAFT_REPO_DEFAULT}; ` +
        `${DRAFT_REPO_ENV} cannot redirect drafts to another repository. ` +
        "Changing the destination needs a code change and a live GitHub check that the " +
        "target is private (npm run admin:verify-github).",
      privacyProvable: false,
    };
  }
  return { repo: DRAFT_REPO_DEFAULT, role: "draft", problem: null, privacyProvable: true };
}

/**
 * What GitHub told us about a repository.
 *
 * `private` is deliberately `boolean | null`: a missing field, a non-boolean,
 * or "we could not read it" must never be treated as private.
 */
export interface RepoVisibility {
  full_name: string;
  private: boolean | null;
}

export interface TargetVerdict {
  writable: boolean;
  /** Non-null when writing is forbidden; safe to print (holds no secrets). */
  problem: string | null;
}

export interface WritableRepoOptions {
  /**
   * Which destination the caller is allowed to write to.
   *
   * - `"drafts"` (default): only `DRAFT_REPO_DEFAULT` may be written to. This
   *   is what the CMS generator and every content path use.
   * - `"verified"`: the caller may name another repository, but only after
   *   `visibility` proves it is private. Used by the verification CLI, which
   *   must be able to inspect a repository the owner names.
   */
  destination?: "drafts" | "verified";
}

/**
 * The single write gate.
 *
 * Conditions, all mandatory:
 *   1  the value must look like `owner/name`;
 *   2  it must not be the public site repository (checked by name, so a
 *      misreported visibility flag cannot help);
 *   3  the destination rule above must hold;
 *   4  when `visibility` is supplied, GitHub must say `private === true` about
 *      the *same* repository.
 *
 * There is no argument that turns a refusal into a warning.
 */
export function checkWritableRepo(
  target: string,
  visibility?: RepoVisibility | null,
  options: WritableRepoOptions = {},
): TargetVerdict {
  const repo = normalizeRepo(target);
  if (!REPO_RE.test(repo)) {
    return { writable: false, problem: `${JSON.stringify(target)} is not a valid "owner/name" repository` };
  }
  if (classifyRepo(repo) === "public") {
    return {
      writable: false,
      problem:
        `${repo} is the PUBLIC repository — draft edits must never be written there ` +
        "(requirement 5). Point the drafts target at the private drafts repository instead.",
    };
  }
  if ((options.destination ?? "drafts") === "drafts" && !isSameRepo(repo, DRAFT_REPO_DEFAULT)) {
    return {
      writable: false,
      problem:
        `${repo} is not the agreed drafts destination (${DRAFT_REPO_DEFAULT}); ` +
        "a repository name is not proof that it is private, so it cannot be a write target",
    };
  }
  if (visibility) {
    if (!isSameRepo(visibility.full_name, repo)) {
      return {
        writable: false,
        problem: `GitHub reported a different repository (${visibility.full_name}) than the configured target (${repo})`,
      };
    }
    if (visibility.private !== true) {
      return {
        writable: false,
        problem:
          `refusing to write to ${repo}: GitHub reports private=${String(visibility.private)}, ` +
          "and drafts are only ever written to a repository GitHub confirms is PRIVATE",
      };
    }
  } else if ((options.destination ?? "drafts") === "verified") {
    // Inspection mode with no proof yet: the caller may read, but this verdict
    // must never be used to justify a write.
    return {
      writable: false,
      problem: `refusing to write to ${repo}: GitHub has not confirmed that it is private yet`,
    };
  }
  return { writable: true, problem: null };
}

/**
 * True only for a repository this project is allowed to write drafts into.
 * Pass `visibility` whenever GitHub's `GET /repos/{o}/{r}` answer is available;
 * a public repository is then rejected whatever its name is.
 */
export function isWritableTarget(
  repo: string,
  visibility?: RepoVisibility | null,
  options: WritableRepoOptions = {},
): boolean {
  return checkWritableRepo(repo, visibility, options).writable;
}

/**
 * What GitHub told us about the authenticated user's access to the repository.
 *
 * ⚠ IMPORTANT: GitHub does **not** expose a read-only endpoint that reports the
 * effective permissions of a fine-grained PAT. `GET /repos/{o}/{r}` returns a
 * `permissions` block describing the *authenticated user's* access to that
 * repository (pull/push/admin), not the token's scopes. A user who can push
 * with the web UI will still see `push: true` when the PAT itself is read-only.
 * The API additionally documents that a token whose permissions are too narrow
 * receives 403 or 404 depending on the endpoint.
 *
 * Consequences, which the probe is built around:
 *   - `push: true` is necessary but **not sufficient** evidence of write access;
 *   - the only trustworthy proof of `Contents: write` is a write that GitHub
 *     accepts (or rejects with 403);
 *   - therefore the probe keeps its write to a throwaway branch, and reports a
 *     403 on `createRef` as "the token cannot write here", not as a mystery.
 */
export interface RepositoryAccess {
  full_name: string;
  /** GitHub's `permissions.push` — repository access of the *user*, not the token. */
  push: boolean;
  /** `permissions.pull`, when reported. */
  pull?: boolean;
  /** False when GitHub did not report a permissions block at all. */
  reported: boolean;
}

/**
 * Evidence about the scratch branch, from an exact ref lookup.
 *
 * Only `absent` — a confirmed 404 for that exact ref — may allow a write to
 * proceed. `present` means somebody else's branch: never reused, never
 * overwritten, never deleted. `unknown` (401/403/5xx/network/incomplete body)
 * blocks the write, because an error is not proof that a branch is missing.
 */
export type BranchEvidence =
  | { state: "absent"; ref: string }
  | { state: "present"; ref: string; head: string }
  | { state: "unknown"; ref: string; reason: string };

export interface WritePreconditions {
  /** The repository the caller asked for (already resolved/validated). */
  requestedRepo: string;
  /** GitHub's `GET /repos/{o}/{r}` answer. */
  visibility: RepoVisibility;
  /** GitHub's `permissions` block for the authenticated user, if reported. */
  access: RepositoryAccess | null;
  /** Exact-ref evidence about the scratch branch. */
  branchExistence: BranchEvidence;
  /** The scratch branch the run intends to create. */
  branch: string;
  /** The repository's default branch, per GitHub. */
  defaultBranch: string;
}

/**
 * **The write-precondition policy.** One function, used by the CLI *and*
 * enforced again inside `runSveltiaTrace()` immediately before `createRef`.
 *
 * Every condition is mandatory and every one fails closed:
 *   1  the name must not be the public site repository;
 *   2  GitHub must confirm `private === true` and answer for the same name;
 *   3  the user's reported access must allow pushing (missing block = refuse);
 *   4  the target must not be the default branch or `main`;
 *   5  the exact branch ref must be confirmed absent — an error is not absence.
 *
 * Note what is *not* claimed here: (3) cannot prove the PAT has
 * `Contents: write` (see `RepositoryAccess`). That is why the probe's write
 * target is a throwaway branch and why a 403 on `createRef` is reported as a
 * failed probe rather than silently retried.
 */
export function verifyWritePreconditions(conditions: WritePreconditions): TargetVerdict {
  const repo = normalizeRepo(conditions.requestedRepo);

  const target = checkWritableRepo(repo, conditions.visibility, { destination: "verified" });
  if (!target.writable) return target;

  if (!isSameRepo(conditions.visibility.full_name, repo)) {
    return {
      writable: false,
      problem: `GitHub resolved ${repo} to ${conditions.visibility.full_name}; refusing to write`,
    };
  }

  if (!conditions.access || !conditions.access.reported) {
    return {
      writable: false,
      problem:
        `GitHub did not report a permissions block for ${repo}, so write access is unproven; ` +
        "refusing to start a probe that could fail halfway",
    };
  }
  if (conditions.access.push !== true) {
    return {
      writable: false,
      problem:
        `the authenticated user cannot push to ${repo} (permissions.push=${String(conditions.access.push)}); ` +
        "nothing was attempted",
    };
  }

  if (conditions.branch === conditions.defaultBranch || conditions.branch.toLowerCase() === DRAFT_BRANCH) {
    return {
      writable: false,
      problem: `refusing to probe "${conditions.branch}": the probe only writes to a scratch branch, never to ${conditions.defaultBranch}`,
    };
  }

  switch (conditions.branchExistence.state) {
    case "present":
      return {
        writable: false,
        problem:
          `scratch branch "${conditions.branch}" already exists (head ` +
          `${conditions.branchExistence.head.slice(0, 7)}); it is left untouched — pass --branch with a fresh name`,
      };
    case "unknown":
      return {
        writable: false,
        problem:
          `could not confirm whether "${conditions.branch}" already exists ` +
          `(${conditions.branchExistence.reason}); an API error is not proof of absence, so nothing was written`,
      };
    case "absent":
      return { writable: true, problem: null };
    default: {
      const exhaustive: never = conditions.branchExistence;
      return { writable: false, problem: `unrecognised branch evidence: ${JSON.stringify(exhaustive)}` };
    }
  }
}
