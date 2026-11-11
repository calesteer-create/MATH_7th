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

/* ── Canonicalisation of CMS-written paths ──────────────────────────────── */

/**
 * The forms a stored `images[].file` value may take, fully enumerated.
 *
 * Sveltia writes the asset's public path, built as `publicFolder + '/' + name`
 * (`lib/utils/file/path.js` → `HJ`). With the collection folder configured as
 * `/public/media/lessons/{{slug}}` and the public folder as
 * `/media/lessons/{{slug}}`, the value is always one of the middle two shapes
 * below. The bare form is accepted because it is the canonical one and the
 * importer (`npm run media:import`) already writes it.
 *
 * The list is deliberately CLOSED: a value that matches none of these is not
 * repaired by guessing, it is rejected. Every pattern is anchored, contains no
 * `.*` across separators, and forbids `.`/`..` segments structurally — the
 * character class `[a-z0-9][a-z0-9-]{0,60}` cannot express a dot except in the
 * `.webp` suffix.
 */
const LESSON_FILE = "([a-z0-9][a-z0-9-]{0,60}\\.webp)";
const CANONICAL_FORMS: ReadonlyArray<RegExp> = [
  // 1. page-01.webp — what media:import writes and what the model expects.
  new RegExp(`^${LESSON_FILE}$`),
  // 2/3/4. A full public path for exactly this lesson.
  new RegExp(`^/media/lessons/(\\d{1,9})/${LESSON_FILE}$`),
  new RegExp(`^public/media/lessons/(\\d{1,9})/${LESSON_FILE}$`),
  new RegExp(`^/public/media/lessons/(\\d{1,9})/${LESSON_FILE}$`),
];

/**
 * Reduces a stored `images[].file` value to the bare, canonical filename.
 *
 * Returns `null` for anything that is not exactly one of CANONICAL_FORMS, or
 * whose embedded lesson id disagrees with `lessonId`. It is a **parser, never a
 * normaliser**: it does not call `path.normalize`, it does not strip `..`, `%`,
 * `\`, `//` or a leading `./` to "make it work", and it never touches the file
 * system. A legal name is returned unchanged (idempotent), so re-running
 * `media:sync` cannot oscillate.
 *
 * Why so strict: the value ends up in a filesystem path
 * (`path.join(mediaRoot, "lessons", id, file)`), so a permissive parser is a
 * path-traversal hole. Refusing is always safe; a caller that gets `null` must
 * report the record and leave it untouched.
 */
export function canonicalMediaFile(raw: unknown, lessonId: number): string | null {
  if (typeof raw !== "string") return null;
  if (!Number.isInteger(lessonId) || lessonId < 1) return null;
  // Cheap structural refusals first, so a hostile value can never reach a regex
  // that might be tempted to repair it. Whitespace (incl. newlines) is included
  // because Sveltia trims file names and a mismatch means corruption, not slack.
  if (raw.length === 0 || raw.length > 200) return null;
  if (/[\s\\%]/.test(raw)) return null;
  if (raw.includes("..") || raw.includes("//")) return null;
  if (raw.startsWith("./") || raw.startsWith("@") || raw.includes(":")) return null;

  for (const pattern of CANONICAL_FORMS) {
    const match = pattern.exec(raw);
    if (!match) continue;
    // Forms 2–4 carry the lesson id; form 1 has no capture groups.
    if (match.length === 2) {
      return raw === match[1] ? match[1]! : null;
    }
    const [, embeddedId, fileName] = match;
    // Exact string match, not `Number(...) === lessonId`: the entry's folder is
    // named from `slug.template {{fields.id}}`, so `03` is never a folder this
    // project writes. Accepting it would widen the contract for no reason.
    if (embeddedId !== String(lessonId)) return null;
    return fileName!;
  }
  return null;
}
