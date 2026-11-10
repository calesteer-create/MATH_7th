/**
 * Repository write guard (PR 5 requirement 5/10).
 *
 * Every code path that writes content in this PR must prove it is writing to
 * the *draft* repository and never to the public one. Rather than trusting
 * scattered comments, both the CMS config and the verification script derive
 * their target from this single module, and a test asserts the public repo
 * (the origin of this checkout) can never be selected.
 *
 * The public repository is not configured anywhere as a writable target: it is
 * hard-coded as the forbidden value, so a typo in an environment variable
 * cannot silently point edits at it.
 */

export const PUBLIC_REPO = "calesteer-create/MATH_7th";
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

/**
 * Resolves the draft repository to use, refusing anything unsafe.
 *
 * - malformed → problem
 * - the public repository → problem (hard block, requirement 5)
 * - a different repository → allowed but flagged, because the owner may
 *   legitimately rename the drafts repo; the CMS config test still refuses
 *   the public one.
 */
export function resolveDraftRepo(env: Record<string, string | undefined> = {}): TargetResolution {
  const requested = env[DRAFT_REPO_ENV];
  const repo = normalizeRepo(requested && requested.trim() ? requested : DRAFT_REPO_DEFAULT);
  if (!REPO_RE.test(repo)) {
    return {
      repo,
      role: "foreign",
      problem: `${DRAFT_REPO_ENV} must look like "owner/name", got ${JSON.stringify(requested)}`,
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
    };
  }
  return { repo, role, problem: null };
}

/** True only for a repository this project is allowed to write drafts into. */
export function isWritableTarget(repo: string): boolean {
  return classifyRepo(repo) !== "public" && REPO_RE.test(normalizeRepo(repo));
}
