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
  /**
   * False when static code alone cannot prove the target is private — always
   * the case for a renamed (foreign) repository. The generator surfaces this
   * in the panel and the docs; the verification CLI must confirm it with
   * GitHub before writing, and refuses when `private !== true`.
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
  return { repo, role, problem: null, privacyProvable: role === "draft" };
}

/**
 * What GitHub told us about a repository's visibility.
 *
 * `private` is deliberately `boolean | null`: a missing field, a non-boolean,
 * or "we could not read it" must never be treated as private. Draft content is
 * published the moment it lands in a public repository, so the only acceptable
 * answer is a literal `true`.
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

/**
 * The single gate every write path must pass.
 *
 * Two independent conditions, both mandatory:
 *   1  the name must not be the public site repository (works even offline,
 *      so a typo or an env var cannot point edits at it);
 *   2  when visibility is known, GitHub must say `private === true`.
 *
 * `visibility === null` means "not checked yet" — callers that can check it
 * (the verification CLI, the trace) must check it before writing; callers that
 * cannot (static CMS config generation) must mark the target as unverified.
 * There is no argument that can downgrade a refusal to a warning.
 */
export function checkWritableRepo(target: string, visibility?: RepoVisibility | null): TargetVerdict {
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
  if (visibility) {
    if (normalizeRepo(visibility.full_name).toLowerCase() !== repo.toLowerCase()) {
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
  }
  return { writable: true, problem: null };
}

/**
 * True only for a repository this project is allowed to write drafts into.
 * Pass `visibility` whenever GitHub's `GET /repos/{o}/{r}` answer is available;
 * a public repository is then rejected whatever its name is.
 */
export function isWritableTarget(repo: string, visibility?: RepoVisibility | null): boolean {
  return checkWritableRepo(repo, visibility).writable;
}
