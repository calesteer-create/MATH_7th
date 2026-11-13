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
 *
 * ## Symlinks: refused, not followed
 *
 * `fs.existsSync()` + `fs.copyFileSync()` resolve symbolic links, so a link at
 * `public/media/lessons/1/page-01.webp` (or at the lesson folder, or at
 * `thumbs/`) would publish whatever it points at — including a file outside the
 * media root. The filename rule does not help: the *name* is always legal, it is
 * the target that is not ours. `content:validate` does not help either: it reads
 * media through `src/lib/dirfd.ts` with `O_NOFOLLOW`, so it reports the link as
 * a missing file while path-based code would happily read through it.
 *
 * So nothing here inspects a path and then opens it. Every component below the
 * media root is opened **relative to its parent's directory descriptor** with
 * `O_NOFOLLOW | O_DIRECTORY` (`src/lib/dirfd.ts`), and the leaf with
 * `O_NOFOLLOW` plus an `fstat` type check, so:
 *
 *   - a link to a file, wherever it points, is refused      (`unsafe`);
 *   - a linked lesson folder or `thumbs` folder is refused  (`unsafe`);
 *   - the bytes that are copied are the bytes that were checked — the file is
 *     read here and handed to the build as a buffer, never re-opened by name.
 *
 * A refused component fails the build. It is never skipped quietly: the author
 * has to decide whether the file belongs in the repository.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDir, openDirUnder, readFileAt } from "../src/lib/dirfd.ts";

/** Mirrors src/content/model.ts#IMAGE_FILE_RE. */
export const MEDIA_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.webp$/;

/**
 * Reads a published lesson file.
 *
 * The file is opened with `O_NOFOLLOW` and must be a regular file, then parsed
 * from the bytes that were read — no second open by name. A file that is a
 * symlink, a directory, a FIFO or unreadable is reported as unsafe instead of
 * being skipped, because skipping a *published* lesson silently is how the JSON
 * tree and the built site start to disagree.
 *
 * @param {string} contentRoot
 * @param {number} lessonId
 * @returns {{ok: true, lesson: any} | {ok: false, reason: string}}
 */
function readPublishedLesson(contentRoot, lessonId) {
  let dir;
  try {
    dir = openDir(path.join(contentRoot, "lessons"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { ok: false, reason: "the lessons folder disappeared from the content tree" };
    }
    return { ok: false, reason: describeError(error) };
  }
  try {
    const name = `${lessonId}.json`;
    const raw = readFileAt(dir, name);
    if (raw === null) return { ok: false, reason: `${name} is missing` };
    let lesson;
    try {
      lesson = JSON.parse(raw.toString("utf8"));
    } catch {
      return { ok: false, reason: `${name} is not valid JSON` };
    }
    return { ok: true, lesson };
  } catch (error) {
    // A linked or non-regular entry lands here: the descriptor layer refuses it
    // rather than reading through it.
    return { ok: false, reason: describeError(error) };
  } finally {
    dir.close();
  }
}

/**
 * Ids of published lessons, read through descriptors.
 *
 * Returns [] only when the tree does not exist yet (a fresh checkout), which
 * keeps the empty-site build working as before. A malformed file is *not*
 * skipped: the build must stop rather than publish a site that silently lost a
 * lesson. `npm run content:validate` runs before the build in CI and names the
 * problem precisely; this is the fail-closed backstop.
 *
 * @param {string} contentRoot
 * @returns {number[]}
 */
export function publishedLessonIds(contentRoot) {
  const dirPath = path.join(contentRoot, "lessons");
  if (!fs.existsSync(dirPath)) return [];

  const ids = [];
  let dir;
  try {
    dir = openDir(dirPath);
  } catch (error) {
    throw new Error(
      `publishedLessonIds — cannot open ${path.relative(process.cwd(), dirPath)}: ${describeError(error)}`,
    );
  }
  try {
    for (const entry of dir.list()) {
      if (!entry.name.endsWith(".json")) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`publishedLessonIds — ${entry.name} is a symbolic link; refusing to read it`);
      }
      if (!entry.isFile()) continue;
      const stem = entry.name.slice(0, -".json".length);
      if (!/^[1-9]\d{0,8}$/.test(stem)) {
        throw new Error(`publishedLessonIds — ${entry.name} is not named <lessonId>.json`);
      }
      const id = Number(stem);
      const read = readPublishedLesson(contentRoot, id);
      if (!read.ok) throw new Error(`publishedLessonIds — ${entry.name}: ${read.reason}`);
      const lesson = read.lesson;
      if (!lesson || typeof lesson !== "object") {
        throw new Error(`publishedLessonIds — ${entry.name} is not a JSON object`);
      }
      if (lesson.id !== id) {
        throw new Error(`publishedLessonIds — ${entry.name} declares id ${String(lesson.id)}`);
      }
      // An unknown status is not a draft by default: a typo ("Published",
      // "publish", a missing field) would otherwise hide a lesson from the site
      // with no error anywhere, which is exactly the silent bypass to avoid.
      if (lesson.status !== "published" && lesson.status !== "draft") {
        throw new Error(
          `publishedLessonIds — ${entry.name} has status ${JSON.stringify(lesson.status)}; expected "published" or "draft"`,
        );
      }
      if (lesson.status === "published") ids.push(id);
    }
  } finally {
    dir.close();
  }
  return ids.sort((a, b) => a - b);
}

/**
 * The copy plan: one entry per file that must exist in the artefact.
 *
 * Each entry is `{ lessonId, variant, source, relative, bytes, sha256 }`, where
 * `relative` is the path under the artefact root (`media/lessons/<id>/<file>`)
 * and `bytes`/`sha256` describe the exact content that was read through the
 * checked descriptor — the build writes those bytes and verifies the same hash,
 * so what ships is what was validated.
 *
 * Three outcomes, all explicit:
 *   plan     — checked and safe to publish
 *   missing  — referenced by a published lesson but absent (build must fail)
 *   invalid  — the filename breaks the naming rule (build must fail)
 *   unsafe   — a symlink or non-regular component, or an unreadable tree
 *              (build must fail)
 *
 * @param {string} contentRoot
 * @param {string} mediaRoot
 * @returns {{
 *   plan: Array<{lessonId: number, variant: "web"|"thumb", source: string, relative: string, bytes: Buffer, sha256: string}>,
 *   missing: Array<{lessonId: number, variant: "web"|"thumb", file: string, source: string}>,
 *   invalid: Array<{lessonId: number, file: string}>,
 *   unsafe: Array<{lessonId: number, variant: "web"|"thumb", file: string, reason: string}>,
 * }}
 */
export function staticScanCopyPlan(contentRoot, mediaRoot) {
  const plan = [];
  const missing = [];
  const invalid = [];
  const unsafe = [];

  const publishedIds = publishedLessonIds(contentRoot);

  // The media root is opened once. Its own components may legitimately be links
  // (a developer checkout, a CI temp dir), so `openDir` pins the root inode
  // without walking through a link *below* it — which is the boundary we own.
  let rootHandle = null;
  try {
    rootHandle = openDir(mediaRoot);
    // The root itself is the operator's declared boundary, but the `lessons`
    // level inside it must be a real folder: everything below hangs from here.
    if (fs.lstatSync(path.join(mediaRoot, "lessons")).isSymbolicLink()) {
      throw new Error("lessons/ is a symbolic link; refusing to publish through it");
    }
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      rootHandle = null;
    } else {
      throw new Error(`staticScanCopyPlan — cannot open the media root ${mediaRoot}: ${describeError(error)}`);
    }
  }

  try {
    for (const lessonId of publishedIds) {
      const read = readPublishedLesson(contentRoot, lessonId);
      if (!read.ok) throw new Error(`staticScanCopyPlan — lesson ${lessonId}: ${read.reason}`);
      const lesson = read.lesson;
      if (lesson.images !== undefined && !Array.isArray(lesson.images)) {
        throw new Error(`staticScanCopyPlan — lesson ${lessonId}: images is not a list`);
      }
      const images = Array.isArray(lesson.images) ? lesson.images : [];

      for (const image of images) {
        const file = typeof image?.file === "string" ? image.file : "";
        if (!MEDIA_FILE_RE.test(file)) {
          invalid.push({ lessonId, file });
          continue;
        }

        for (const variant of ["web", "thumb"]) {
          const targetDirParts = variant === "thumb" ? ["lessons", String(lessonId), "thumbs"] : ["lessons", String(lessonId)];
          const relative = variant === "thumb" ? `media/lessons/${lessonId}/thumbs/${file}` : `media/lessons/${lessonId}/${file}`;
          const source = path.join(mediaRoot, "lessons", String(lessonId), ...(variant === "thumb" ? ["thumbs"] : []), file);

          if (rootHandle === null) {
            missing.push({ lessonId, variant, file, source });
            continue;
          }

          const entry = readScanAt(rootHandle, targetDirParts, file, { lessonId, variant, file, source }, missing, unsafe);
          if (entry === null) continue;

          plan.push({
            lessonId,
            variant,
            source,
            relative,
            bytes: entry.bytes,
            sha256: entry.sha256,
          });
        }
      }
    }
  } finally {
    rootHandle?.close();
  }

  return { plan, missing, invalid, unsafe };
}

/**
 * Reads one scan relative to the pinned media root, refusing any symlink or
 * non-directory component on the way down.
 *
 * Returns the bytes that were read, so the caller copies exactly what was
 * checked, or `null` after recording why it cannot be published.
 */
function readScanAt(rootHandle, dirParts, file, descriptor, missing, unsafe) {
  let parent = null;
  try {
    try {
      parent = openDirUnder(rootHandle, dirParts);
    } catch (error) {
      if (isUnsafe(error)) {
        unsafe.push({ ...pick(descriptor), reason: describeError(error) });
        return null;
      }
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        // Absent folder: report the file as missing, which fails the build with
        // a message naming the lesson. A *linked* folder raises ELOOP below.
        missing.push(descriptor);
        return null;
      }
      unsafe.push({ ...pick(descriptor), reason: describeError(error) });
      return null;
    }
    const bytes = readFileAt(parent, file);
    if (bytes === null) {
      missing.push(descriptor);
      return null;
    }
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    unsafe.push({ ...pick(descriptor), reason: describeError(error) });
    return null;
  } finally {
    parent?.close();
  }
}

/** The fields recorded in `unsafe` — a reason, not a buffer. */
function pick(descriptor) {
  return { lessonId: descriptor.lessonId, variant: descriptor.variant, file: descriptor.file };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * True when the descriptor layer refused a component because it is a symlink or
 * not a directory. `openat(..., O_NOFOLLOW | O_DIRECTORY)` reports both as
 * ELOOP/ENOTDIR, so the errno alone cannot tell "linked" from "missing"; the
 * `lstat`-based helpers below therefore decide before the walk happens.
 */
function isUnsafe(error) {
  return Boolean(error) && (error.code === "ELOOP" || error.name === "UnsafeComponentError");
}

/** One short, stable description for a filesystem refusal. */
function describeError(error) {
  const code = error && error.code ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ELOOP") return "a component of the path is a symbolic link (refused)";
  return code ? `${message} (${code})` : message;
}
