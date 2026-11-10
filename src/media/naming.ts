/**
 * Deterministic, collision-free media filenames.
 *
 * The content model accepts exactly `^[a-z0-9][a-z0-9-]{0,60}\.webp$`
 * (src/content/model.ts#IMAGE_FILE_RE). That rule is a security boundary, not
 * cosmetics: no slashes means no `../` escape from the lesson folder, no
 * uppercase means no case-insensitive collisions on macOS/Windows checkouts,
 * and no spaces means no URL-encoding surprises.
 *
 * The importer must also be *stable*: importing the same page twice must not
 * create `page-01-2.webp`. Two separate concerns therefore live here:
 *
 *   1. sanitizeBase() — turn any human label into a legal stem, or refuse.
 *   2. nextFreeName()  — add a numeric suffix only when the name is genuinely
 *                        taken by *different* content (see naming policy in
 *                        src/media/import.ts).
 */

/** Mirrors src/content/model.ts#IMAGE_FILE_RE — single source would be nice but
 *  the model must stay dependency-free for the static build; a test asserts
 *  these two agree. */
export const MEDIA_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.webp$/;
export const MAX_STEM_LENGTH = 61;

const RESERVED = new Set(["thumbs", "con", "prn", "aux", "nul"]);

/**
 * Lowercases, ASCII-folds, and replaces every other run of characters with a
 * single hyphen. Arabic labels do not survive ASCII folding, which is why the
 * caller falls back to a positional stem ("page-03") instead of transliterating
 * — a stable readable name beats a lossy guess.
 */
export function sanitizeBase(input: string): string | null {
  const folded = input
    .normalize("NFKD")
    // Drop combining marks so "Café" → "Cafe" rather than "Caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STEM_LENGTH);
  if (folded.length === 0) return null;
  if (RESERVED.has(folded)) return null;
  return folded;
}

/** `page-03` — the guaranteed-available stem for a 1-based page position. */
export function positionalStem(position: number): string {
  return `page-${String(position).padStart(2, "0")}`;
}

/**
 * Returns `base.webp`, or `base-2.webp`, `base-3.webp`… for the first name that
 * the caller reports as free. Suffixes keep the stem legal: a name that would
 * exceed the 61-character limit is truncated so the total stays valid.
 */
export function nextFreeName(base: string, isTaken: (candidate: string) => boolean): string {
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const room = MAX_STEM_LENGTH - suffix.length;
    const stem = base.slice(0, Math.max(1, room));
    const candidate = `${stem}${suffix}.webp`;
    if (!MEDIA_FILE_RE.test(candidate)) continue;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`could not find a free filename for "${base}" after 999 attempts`);
}

/** True when the name already satisfies the content-model rule. */
export function isLegalMediaName(name: string): boolean {
  return MEDIA_FILE_RE.test(name);
}
