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
import { openDirInside, resolveInside, writeFileInside } from "./tree";
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

/**
 * Reads `<mediaRoot>/lessons/<id>/*.webp` (not recursive, ignores thumbs/).
 *
 * The path is proved safe *before* the directory is touched: `readdir` follows a
 * symlinked component, so a lesson folder that is a link out of `mediaRoot`
 * would otherwise enumerate — and then hash — files outside the tree. Reading is
 * a different boundary from writing, and it needs its own guard.
 */
export function listLessonMediaFiles(mediaRoot: string, lessonId: number): string[] {
  // The directory is opened component by component relative to its parent's
  // descriptor, then listed *through that descriptor*. A component swapped in the
  // textual path after the walk began cannot redirect the listing: the kernel
  // resolves against the pinned inode, and `readdir` on the fd has no path to
  // re-resolve.
  const dir = openDirInside(mediaRoot, lessonMediaDir(mediaRoot, lessonId));
  if (dir === null) return [];
  try {
    return dir
      .list()
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webp"))
      .map((entry) => entry.name)
      .sort();
  } finally {
    dir.close();
  }
}

/**
 * sha256 of an existing file, or null when it is missing/unreadable.
 *
 * When a `root` is given (every internal caller), the path is verified to stay
 * inside it before a byte is read, and the *read* itself is then re-verified:
 * `O_NOFOLLOW` protects the final component, and the resolved path is compared
 * against the root afterwards so a component swapped in the interim cannot make
 * this hash a file outside the tree. Without a root this is a plain hash and
 * must not be handed an unverified path.
 */
export function fileSha256(file: string, root?: string): string | null {
  if (root === undefined) {
    try {
      return sha256Hex(fs.readFileSync(file));
    } catch {
      return null;
    }
  }
  let parent: ReturnType<typeof openDirInside> = null;
  try {
    // Open the *parent* directory fd-relatively and then the leaf relative to it.
    // No path is resolved twice, so there is no window between a check and a read
    // for a swap to exploit: the descriptor is the authority.
    const safe = resolveInside(root, file);
    parent = openDirInside(root, path.dirname(safe));
    if (parent === null) return null;
    const name = path.basename(safe);
    let fd: number;
    try {
      fd = parent.open(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      // Belt and braces: the entry must be a regular file, checked on the
      // descriptor itself rather than on a name.
      if (!fs.fstatSync(fd).isFile()) return null;
      return sha256Hex(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  } finally {
    parent?.close();
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
  const reuse = onDisk.find((name) => fileSha256(path.join(dir, name), mediaRoot) === processed.sha256);
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
  // Same containment rule as media:sync, applied inside the library function so
  // a direct caller is protected too — not only the CLI. A pre-existing symlink
  // anywhere below mediaRoot is refused before anything is created.
  //
  // The *resolved* paths are what this function returns, so caller and disk
  // agree even when mediaRoot is itself a symlink. Returning the unresolved
  // spelling would describe files at a location that is not where they are.
  const resolvedWebPath = resolveInside(mediaRoot, webPath);
  const resolvedThumbPath = resolveInside(mediaRoot, thumbPath);

  if (!options.dryRun && !reused) {
    // Exclusive create: a name that slipped past the collision check can never
    // clobber an existing page, and a symlink at either target is not followed.
    writeFileInside(mediaRoot, resolvedWebPath, processed.web, { exclusive: true });
    writeFileInside(mediaRoot, resolvedThumbPath, processed.thumb, { exclusive: true });
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
    webPath: resolvedWebPath,
    thumbPath: resolvedThumbPath,
    reused,
    processed,
  };
}

function processedStem(label: string | undefined, existing: readonly LessonImageContent[], next: number): string {
  if (!label) return positionalStem(next);
  return label;
}
