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

/** What GitHub told us about the token's own capabilities on the repository. */
export interface TokenPermissions {
  push: boolean;
  contents: "none" | "read" | "write" | "unknown";
}

export interface WritePreconditions {
  /** The repository the caller asked for (already resolved/validated). */
  requestedRepo: string;
  /** GitHub's `GET /repos/{o}/{r}` answer. */
  visibility: RepoVisibility;
  /** GitHub's `permissions` block for this token, if reported. */
  token?: TokenPermissions | null;
  /** Branches that already exist in the repository. */
  existingBranches: readonly string[];
  /** The scratch branch the run intends to create. */
  branch: string;
  /** The repository's default branch, per GitHub. */
  defaultBranch: string;
}

/**
 * Everything that must be true *before* the verification probe writes anything.
 *
 * Both this and `checkWritableRepo` are enforced inside `runSveltiaTrace()` and
 * again in the CLI; a caller cannot opt out, and `--yes` only skips the prompt.
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

  if (conditions.token && conditions.token.push !== true) {
    return {
      writable: false,
      problem:
        `the token cannot push to ${repo} (push=${String(conditions.token.push)}); ` +
        "a read-only token would fail mid-probe, so nothing was attempted",
    };
  }
  if (conditions.token && conditions.token.contents !== "write" && conditions.token.contents !== "unknown") {
    return {
      writable: false,
      problem:
        `the token's contents permission is "${conditions.token.contents}", not write; ` +
        "nothing was attempted",
    };
  }

  if (conditions.branch === conditions.defaultBranch || conditions.branch.toLowerCase() === DRAFT_BRANCH) {
    return {
      writable: false,
      problem: `refusing to probe "${conditions.branch}": the probe only writes to a scratch branch, never to ${conditions.defaultBranch}`,
    };
  }

  if (conditions.existingBranches.includes(conditions.branch)) {
    return {
      writable: false,
      problem: `scratch branch "${conditions.branch}" already exists; it is left untouched — pass --branch with a fresh name`,
    };
  }

  return { writable: true, problem: null };
}
