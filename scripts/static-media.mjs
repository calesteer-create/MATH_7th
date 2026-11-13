/**
 * Static media: exactly which published scans belong in the GitHub Pages
 * artefact, and where they land.
 *
 * Plain ESM with no dependencies and no imports from `src/`, because two very
 * different callers must agree on it byte for byte: the copying step in
 * `scripts/build-static.mjs` and the audit boundary — plus the test suite.
 * A single module means the copier and the gate can never disagree about the
 * layout. (Types live in the JSDoc below, so the same code is checked by
 * `npm run typecheck` without a build step.)
 *
 * Layout on the published site (mirrors src/lib/scan-url.ts):
 *
 *   /MATH_7th/media/lessons/<lessonId>/<file>         web scan
 *   /MATH_7th/media/lessons/<lessonId>/thumbs/<file>  thumbnail
 *
 * Only **published** lessons are copied, and only the files they actually
 * reference: a draft's scans must never reach the public artefact, and an
 * orphan file in the working tree must not ride along silently.
 *
 * The filename rule is re-checked here even though `content:validate` already
 * enforces it. That is deliberate: this module is the last gate before bytes
 * become public, and it runs outside TypeScript's type system.
 */
import fs from "node:fs";
import path from "node:path";

/** Mirrors src/content/model.ts#IMAGE_FILE_RE. */
export const MEDIA_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.webp$/;


/**
 * Reads the ids of published lessons. Returns [] when the tree does not exist
 * yet (a fresh checkout with no content), which keeps the empty-site build
 * working exactly as before.
 */
/**
 * @param {string} contentRoot
 * @returns {number[]}
 */
export function publishedLessonIds(contentRoot) {
  const dir = path.join(contentRoot, "lessons");
  if (!fs.existsSync(dir)) return [];
  const ids = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
    } catch {
      // A malformed file is content:validate's job to report; do not guess here.
      continue;
    }
    if (parsed && parsed.status === "published" && Number.isInteger(parsed.id) && parsed.id > 0) {
      ids.push(parsed.id);
    }
  }
  return ids.sort((a, b) => a - b);
}

/**
 * The copy plan: one entry per file that must exist in the artefact.
 *
 * Each entry is `{ lessonId, variant, source, relative }`, where `source` is
 * absolute (under `public/media/lessons/<id>`) and `relative` is the path under
 * the artefact root (`media/lessons/<id>/<file>`). Files the content tree
 * references but that do not exist are reported in `missing`, never skipped
 * silently: a published lesson with a missing scan must fail the build rather
 * than ship a hole.
 */
/**
 * @param {string} contentRoot
 * @param {string} mediaRoot
 * @returns {{
 *   plan: Array<{lessonId: number, variant: "web"|"thumb", source: string, relative: string}>,
 *   missing: Array<{lessonId: number, variant: "web"|"thumb", file: string, source: string}>,
 *   invalid: Array<{lessonId: number, file: string}>,
 * }}
 */
export function staticScanCopyPlan(contentRoot, mediaRoot) {
  const plan = [];
  const missing = [];
  const invalid = [];

  for (const lessonId of publishedLessonIds(contentRoot)) {
    const lessonFile = path.join(contentRoot, "lessons", `${lessonId}.json`);
    let lesson;
    try {
      lesson = JSON.parse(fs.readFileSync(lessonFile, "utf8"));
    } catch {
      continue; // reported by content:validate
    }
    const images = Array.isArray(lesson.images) ? lesson.images : [];
    for (const image of images) {
      const file = typeof image?.file === "string" ? image.file : "";
      if (!MEDIA_FILE_RE.test(file)) {
        invalid.push({ lessonId, file });
        continue;
      }
      const folder = path.join(mediaRoot, "lessons", String(lessonId));
      const targets = [
        {
          lessonId,
          variant: "web",
          source: path.join(folder, file),
          relative: `media/lessons/${lessonId}/${file}`,
        },
        {
          lessonId,
          variant: "thumb",
          source: path.join(folder, "thumbs", file),
          relative: `media/lessons/${lessonId}/thumbs/${file}`,
        },
      ];
      for (const target of targets) {
        if (!fs.existsSync(target.source)) {
          missing.push({ lessonId, variant: target.variant, file, source: target.source });
          continue;
        }
        plan.push(target);
      }
    }
  }
  return { plan, missing, invalid };
}
