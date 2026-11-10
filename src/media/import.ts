/**
 * Lesson-image import orchestration (PR 5).
 *
 * `importImageIntoLesson()` is the only function that writes media files in
 * this codebase, and it writes to exactly two paths, both derived from a
 * validated integer lesson id and a validated filename:
 *
 *   <mediaRoot>/lessons/<id>/<file>
 *   <mediaRoot>/lessons/<id>/thumbs/<file>
 *
 * Everything else (naming, encoding, validation) is delegated to pure modules
 * so the interesting decisions are unit-testable without touching disk.
 *
 * Naming policy, in order:
 *   1. A file with the *same content* (sha256) already in the lesson folder is
 *      reused — re-importing the same page is idempotent, no `-2` clutter.
 *   2. Otherwise the sanitized label is used, then `label-2`, `label-3`…
 *   3. If the label cannot be sanitized (e.g. Arabic-only), the positional
 *      stem `page-NN` is used, which is also collision-checked.
 */

import fs from "node:fs";
import path from "node:path";
import { isLegalMediaName, nextFreeName, positionalStem, sanitizeBase } from "./naming";
import { MediaError, processSourceImage, sha256Hex, type ProcessedImage } from "./process";
import type { LessonImageContent } from "../content/model";

export const MAX_IMAGES_PER_LESSON = 300;

export interface ImportOptions {
  mediaRoot: string;
  lessonId: number;
  /** Buffer of the original file (never written to disk by this module). */
  source: Buffer;
  /** Human label for the filename (file name, page caption, …). */
  label?: string;
  /** Existing `images[]` of the lesson, for position assignment + collisions. */
  existing?: readonly LessonImageContent[];
  maxBytes?: number;
  /** Compute everything but write nothing. */
  dryRun?: boolean;
}

export interface ImportResult {
  image: LessonImageContent;
  /** Absolute path of the written (or would-be) web rendition. */
  webPath: string;
  thumbPath: string;
  /** True when identical content was already present and reused. */
  reused: boolean;
  processed: ProcessedImage;
}

export function lessonMediaDir(mediaRoot: string, lessonId: number): string {
  assertLessonId(lessonId);
  return path.join(mediaRoot, "lessons", String(lessonId));
}

export function assertLessonId(lessonId: number): void {
  if (!Number.isInteger(lessonId) || lessonId < 1 || lessonId > 999_999_999) {
    throw new Error(`invalid lesson id: ${JSON.stringify(lessonId)}`);
  }
}

/** Reads `<mediaRoot>/lessons/<id>/*.webp` (not recursive, ignores thumbs/). */
export function listLessonMediaFiles(mediaRoot: string, lessonId: number): string[] {
  const dir = lessonMediaDir(mediaRoot, lessonId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webp"))
    .map((entry) => entry.name)
    .sort();
}

/** sha256 of an existing file, or null when it is missing/unreadable. */
export function fileSha256(file: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export async function importImageIntoLesson(options: ImportOptions): Promise<ImportResult> {
  const { mediaRoot, lessonId, source } = options;
  assertLessonId(lessonId);
  const dir = lessonMediaDir(mediaRoot, lessonId);
  const processed = await processSourceImage(source, { maxBytes: options.maxBytes });

  const existing = options.existing ?? [];
  if (existing.length >= MAX_IMAGES_PER_LESSON) {
    throw new MediaError(
      "IMAGE_TOO_LARGE",
      `lesson ${lessonId} already has ${existing.length} images; the limit is ${MAX_IMAGES_PER_LESSON}`,
    );
  }

  // 1. Same content already stored? Reuse the name (idempotent re-import).
  const onDisk = listLessonMediaFiles(mediaRoot, lessonId);
  const reuse = onDisk.find((name) => fileSha256(path.join(dir, name)) === processed.sha256);
  const reused = reuse !== undefined;
  const record = existing.find((image) => image.sha256 === processed.sha256);

  let fileName: string;
  if (reuse) {
    fileName = reuse;
  } else {
    const taken = new Set<string>([...onDisk, ...existing.map((image) => image.file)]);
    const base =
      sanitizeBase(options.label ?? "") ??
      sanitizeBase(processedStem(options.label, existing, existing.length + 1)) ??
      positionalStem(existing.length + 1);
    fileName = nextFreeName(base, (candidate) => taken.has(candidate));
  }
  if (!isLegalMediaName(fileName)) {
    throw new Error(`refusing to write illegal media name ${JSON.stringify(fileName)}`);
  }

  const webPath = path.join(dir, fileName);
  const thumbPath = path.join(dir, "thumbs", fileName);
  assertInside(mediaRoot, webPath);
  assertInside(mediaRoot, thumbPath);

  if (!options.dryRun && !reused) {
    fs.mkdirSync(path.join(dir, "thumbs"), { recursive: true });
    // "wx" fails instead of overwriting: a name that slipped past the collision
    // check can never clobber an existing page.
    fs.writeFileSync(webPath, processed.web, { flag: "wx" });
    fs.writeFileSync(thumbPath, processed.thumb, { flag: "wx" });
  }

  const position =
    record?.position ??
    existing.reduce((max, image) => Math.max(max, image.position), 0) + 1;

  return {
    image: {
      position,
      file: fileName,
      thumb: `thumbs/${fileName}`,
      width: processed.width,
      height: processed.height,
      bytes: processed.sourceBytes,
      sha256: processed.sha256,
    },
    webPath,
    thumbPath,
    reused,
    processed,
  };
}

function processedStem(label: string | undefined, existing: readonly LessonImageContent[], next: number): string {
  if (!label) return positionalStem(next);
  return label;
}

/** Defence in depth: every write path must stay under the media root. */
function assertInside(mediaRoot: string, target: string): void {
  const root = path.resolve(mediaRoot);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to write outside the media root: ${resolved}`);
  }
}
