#!/usr/bin/env node
/**
 * `npm run media:sync` — reconcile the content tree with the files on disk.
 *
 * Why this exists: Sveltia CMS (and any browser editor) can upload a WebP, but
 * it cannot compute the sha256, the pixel dimensions, or the thumbnail that the
 * content model requires (src/content/model.ts#LessonImageContent). Uploaded
 * pages would therefore leave the tree invalid. This script closes that gap:
 *
 *   1. every WebP in public/media/lessons/<id>/ without a thumbnail gets one;
 *   2. every lesson image record is refreshed from the actual file
 *      (sha256, width, height, thumb path);
 *   3. files on disk that no lesson references are reported, never deleted;
 *   4. lesson records that point at a missing file are reported as errors.
 *
 * It is idempotent: running it twice produces byte-identical JSON.
 *
 *   npm run media:sync
 *   npm run media:sync -- --check      # exit 1 if anything would change
 *   npm run media:sync -- --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { THUMB_MAX_EDGE, THUMB_QUALITY, detectMime } from "../src/media/format";
import { sha256Hex } from "../src/media/process";
import { canonicalMediaFile, isLegalMediaName } from "../src/media/naming";
import { buildReferenceIndex, collectedQuizReferences } from "../src/media/sync-helpers";
import {
  defaultPaths,
  nowIso,
  readLessons,
  readQuizFiles,
  formatRollbackReport,
  rollbackWrites,
  writeJson,
} from "../src/media/tree";
import {
  ensureDirPath,
  fileExistsAt,
  openDir,
  openDirUnder,
  readFileAt,
  relativeParts,
  writeFileAt,
} from "../src/lib/dirfd";
import { validateContentTree } from "../src/content/validate";
import type { LessonContent, LessonImageContent } from "../src/content/model";

/** Validator codes that `media:sync` fixes by rewriting the lesson record. */
const REPAIRABLE_CODES = new Set([
  // A CMS-written path (`/media/lessons/3/page-01.webp`) fails the strict
  // model rule until it is canonicalised. Every value that cannot be
  // canonicalised is reported as an unfixable error instead, so this code can
  // only ever be excused for a record a write run actually repairs.
  "IMAGE_FILE_INVALID",
  "IMAGE_THUMB_MISMATCH",
  "IMAGE_HASH_MISMATCH",
  "IMAGE_SHA256_INVALID",
  "IMAGE_THUMB_NOT_FOUND",
  "PUBLISHED_NEEDS_IMAGES",
]);

interface Options {
  check: boolean;
  dryRun: boolean;
  contentRoot: string | null;
  mediaRoot: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { check: false, dryRun: false, contentRoot: null, mediaRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--content") options.contentRoot = argv[++i] ?? null;
    else if (arg === "--media") options.mediaRoot = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      console.log("media:sync [--check] [--dry-run] [--content DIR] [--media DIR]");
      process.exit(0);
    } else if (arg?.startsWith("--")) {
      console.error(`✗ unknown option ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

interface SyncSummary {
  thumbnailsCreated: number;
  recordsUpdated: number;
  lessonsChanged: number;
  orphans: string[];
  missing: string[];
  errors: string[];
  /** `file` values reduced to the canonical bare name (CMS-written paths). */
  canonicalized: Array<{ lessonId: number; from: string; to: string }>;
}

/**
 * The media root in the spelling the descriptor walk uses.
 *
 * `realpath` when it exists (a symlinked root has two names, and the descriptors
 * descend the resolved one); the declared path when it does not, so a fresh
 * checkout can still create it.
 */
function resolveMediaRoot(mediaRoot: string, options: { create: boolean }): string {
  try {
    return fs.realpathSync(mediaRoot);
  } catch {
    if (options.create) return path.resolve(mediaRoot);
    return path.resolve(mediaRoot);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const paths = defaultPaths();
  if (options.contentRoot) paths.contentRoot = path.resolve(options.contentRoot);
  if (options.mediaRoot) paths.mediaRoot = path.resolve(options.mediaRoot);
  const write = !options.dryRun && !options.check;

  const summary: SyncSummary = {
    thumbnailsCreated: 0,
    recordsUpdated: 0,
    lessonsChanged: 0,
    orphans: [],
    missing: [],
    errors: [],
    canonicalized: [],
  };

  console.log("MATH 7TH — media sync");
  console.log(`  content: ${paths.contentRoot}`);
  console.log(`  media:   ${paths.mediaRoot}${write ? "" : " (read-only run)"}\n`);

  const lessonsDir = path.join(paths.mediaRoot, "lessons");
  const changedLessons: LessonContent[] = [];
  /** Writes held back until every lesson has been validated. */
  const pendingWrites: Array<{ file: string; lesson: LessonContent }> = [];
  /**
   * Thumbnails are held back for the same reason as the JSON: a run that aborts
   * because one record cannot be repaired must leave the tree byte-identical,
   * not merely un-canonicalised. `--dry-run` never fills this (see below).
   */
  const pendingThumbs: Array<{ path: string; buffer: Buffer }> = [];

  // The media tree is read through descriptors: the root is opened once and each
  // lesson folder is opened relative to it, so a folder swapped for a link during
  // the run cannot make this phase read or hash anything outside mediaRoot.
  // A fresh checkout may not have produced `public/media` yet: that is an empty
  // tree, not an error, and every page is then reported as missing.
  const mediaRootHandle = ((): ReturnType<typeof openDir> | null => {
    try {
      return openDir(resolveMediaRoot(paths.mediaRoot, { create: false }));
    } catch {
      return null;
    }
  })();
  try {
  for (const entry of readLessons(paths.contentRoot)) {
    const lesson = entry.value;
    const dir = path.join(lessonsDir, String(lesson.id));
    const lessonParts = relativeParts(resolveMediaRoot(paths.mediaRoot, { create: false }), dir);
    let lessonDir: ReturnType<typeof openDir> | null = null;
    try {
      lessonDir = mediaRootHandle === null ? null : openDirUnder(mediaRootHandle, lessonParts);
    } catch {
      lessonDir = null; // absent, or refused; treated as "no files" below
    }
    const nextImages: LessonImageContent[] = [];
    let changed = false;

    for (const image of lesson.images) {
      // ── Canonicalise what the CMS wrote ──────────────────────────────────
      // Sveltia stores the asset's public path (`/media/lessons/3/page-01.webp`,
      // see GLOBAL/LESSON_*_FOLDER in src/media/cms-config.ts), while the
      // content model requires a bare filename. The parser accepts a closed
      // list of shapes and returns null for anything else — it never repairs by
      // guessing, and this step touches no file on disk.
      const canonical = canonicalMediaFile(image.file, lesson.id);
      if (canonical === null) {
        summary.errors.push(
          `lessons/${entry.file}: unrecognised image path ${JSON.stringify(image.file)} ` +
            `(expected a bare .webp name, or /media/lessons/${lesson.id}/<name>.webp)`,
        );
        nextImages.push(image);
        continue;
      }
      if (canonical !== image.file) {
        summary.canonicalized.push({ lessonId: lesson.id, from: image.file, to: canonical });
      }
      const file = canonical;
      if (!isLegalMediaName(file)) {
        summary.errors.push(`lessons/${entry.file}: illegal filename ${JSON.stringify(file)}`);
        nextImages.push(image);
        continue;
      }
      // Read through the pinned lesson descriptor: the bytes and the existence
      // check refer to the same file, and `readFileAt` verifies the type with
      // `fstat` before returning anything.
      const buffer = lessonDir === null ? null : readFileAt(lessonDir, file);
      if (buffer === null) {
        summary.missing.push(`lessons/${lesson.id}/${file}`);
        nextImages.push(image);
        continue;
      }
      if (detectMime(buffer) !== "image/webp") {
        summary.errors.push(`lessons/${lesson.id}/${file} is not a WebP file`);
        nextImages.push(image);
        continue;
      }
      let meta: { width?: number; height?: number };
      try {
        meta = await sharp(buffer).metadata();
      } catch (error) {
        summary.errors.push(
          `lessons/${lesson.id}/${file} cannot be decoded: ${(error as Error).message}`,
        );
        nextImages.push(image);
        continue;
      }
      const refreshed: LessonImageContent = {
        ...image,
        file,
        thumb: `thumbs/${file}`,
        width: meta.width ?? image.width,
        height: meta.height ?? image.height,
        bytes: image.bytes ?? buffer.byteLength,
        sha256: sha256Hex(buffer),
      };
      const thumbPath = path.join(dir, "thumbs", file);
      const thumbExists = ((): boolean => {
        if (lessonDir === null) return false;
        let thumbs: ReturnType<typeof openDir> | null = null;
        try {
          thumbs = openDirUnder(lessonDir, ["thumbs"]);
          return fileExistsAt(thumbs, file);
        } catch {
          return false;
        } finally {
          thumbs?.close();
        }
      })();
      if (!thumbExists) {
        const thumbBuffer = await sharp(buffer)
          .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY, effort: 4 })
          .toBuffer();
        summary.thumbnailsCreated += 1;
        if (write) pendingThumbs.push({ path: thumbPath, buffer: thumbBuffer });
      }
      if (
        file !== image.file ||
        refreshed.sha256 !== image.sha256 ||
        refreshed.width !== image.width ||
        refreshed.height !== image.height ||
        refreshed.thumb !== image.thumb
      ) {
        summary.recordsUpdated += 1;
        changed = true;
      }
      nextImages.push(refreshed);
    }

    // Orphan detection scoped to this lesson folder, listed through the same
    // descriptor the pages were read from.
    if (lessonDir !== null) {
      for (const name of lessonDir.list()) {
        if (!name.isFile() || name.name.toLowerCase().endsWith(".webp") === false) continue;
        if (!nextImages.some((image) => image.file === name.name)) {
          summary.orphans.push(`lessons/${lesson.id}/${name.name}`);
        }
      }
    }
    lessonDir?.close();

    if (changed) {
      summary.lessonsChanged += 1;
      const next: LessonContent = {
        ...lesson,
        images: nextImages,
        contentUpdatedAt: lesson.contentUpdatedAt,
        updatedAt: nowIso(),
      };
      changedLessons.push(next);
      // Deferred on purpose: nothing is written until every lesson has been
      // checked, so a failure halfway through cannot leave one lesson
      // canonicalised and the next one untouched (a "half-edited" tree).
      pendingWrites.push({ file: entry.file, lesson: next });
      // In a read-only run the in-memory record is corrected so orphan
      // detection below still compares against the right set.
    }
  }
  } finally {
    mediaRootHandle?.close();
  }

  const quizRefs = collectedQuizReferences(readQuizFiles(paths.contentRoot));
  const index = buildReferenceIndex(readLessons(paths.contentRoot).map((entry) => entry.value));
  void quizRefs;
  for (const orphan of summary.orphans) {
    const file = orphan.split("/").slice(2).join("/") || orphan;
    const sameName = index.byFile.get(file)?.size ?? 0;
    console.log(
      `  ! orphan ${orphan}${sameName > 0 ? ` (filename also used by ${sameName} lesson(s); not deleted)` : " (not deleted)"}`,
    );
  }
  for (const missing of summary.missing) {
    console.error(`  ✗ missing file referenced by a lesson: ${missing}`);
  }
  for (const error of summary.errors) console.error(`  ✗ ${error}`);
  // Every canonicalisation is listed before anything is written, so
  // `--dry-run` shows the exact set of values a real run would rewrite.
  for (const change of summary.canonicalized) {
    console.log(
      `  → canonicalise lesson ${change.lessonId}: ${JSON.stringify(change.from)} ⇒ ${JSON.stringify(change.to)}`,
    );
  }

  const needsWork = summary.thumbnailsCreated + summary.recordsUpdated > 0;
  // Errors the sync cannot repair always fail the run. Computed before the
  // validation verdict below, because an unfixable record must never be
  // excused by the "a write run would repair this" allowance.
  const unfixable = summary.errors.length + summary.missing.length;

  console.log(
    `\n  thumbnails created: ${summary.thumbnailsCreated}\n` +
      `  image records refreshed: ${summary.recordsUpdated} in ${summary.lessonsChanged} lesson(s)\n` +
      `  orphans: ${summary.orphans.length} · missing: ${summary.missing.length} · errors: ${summary.errors.length}`,
  );

  // Non-strict: IMAGE_ORPHAN is a warning for a human to review, never a
  // deletion — escalating it would make "unused file exists" look fatal.
  //
  // `validateContentTree` reads files. A WRITE run therefore hands it the
  // records it is about to commit (in-memory overrides), so the verdict
  // describes the tree that will exist afterwards and nothing is written until
  // that verdict is clean. A READ-ONLY run has nothing to commit, so the
  // derived-field errors the sync would repair are expected: they are listed
  // and explicitly labelled instead of failing the preview.
  const pendingByFile = new Map(pendingWrites.map((pending) => [`lessons/${pending.file}`, pending.lesson]));
  const validation =
    write && pendingByFile.size > 0
      ? validateContentTree(paths.contentRoot, paths.mediaRoot, { lessonOverrides: pendingByFile })
      : validateContentTree(paths.contentRoot, paths.mediaRoot);
  console.log(`  content validation: ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`);

  const pendingDerivedFieldErrors =
    !write && unfixable === 0 && needsWork
      ? validation.errors.every((issue) => REPAIRABLE_CODES.has(issue.code))
      : false;
  // A write run validates against the pending records, but the thumbnails they
  // promise are still buffered in memory (see `pendingThumbs`) — so validation
  // legitimately reports them as missing on disk. Those exact issues are the
  // ones this run is about to satisfy, so they are excused by name, not by
  // dropping the code wholesale.
  // The message is `missing thumbnail lessons/<id>/<thumb>`; build the same
  // string from the buffered path so the match is exact.
  const deferredThumbs = new Set(
    pendingThumbs.map(
      (thumb) =>
        `missing thumbnail ${path.relative(paths.mediaRoot, thumb.path).split(path.sep).join("/")}`,
    ),
  );
  const verdictErrors = write
    ? validation.errors.filter(
        (issue) => !(issue.code === "IMAGE_THUMB_NOT_FOUND" && deferredThumbs.has(issue.message)),
      )
    : validation.errors;
  const deferredThumbCount = validation.errors.length - verdictErrors.length;

  const shown = pendingDerivedFieldErrors ? validation.warnings : verdictErrors;
  for (const issue of shown.slice(0, 10)) {
    console.log(`   [${issue.code}] ${issue.path} — ${issue.message}`);
  }
  if (pendingDerivedFieldErrors) {
    console.log("   (derived-field errors above are exactly what a write run repairs)");
  }
  if (deferredThumbCount > 0) {
    console.log(`   (${deferredThumbCount} missing thumbnail(s) are created by this run)`);
  }

  const contentBroken = verdictErrors.length > 0 && !pendingDerivedFieldErrors;

  if (options.check && needsWork) {
    console.error("\n✗ media:sync --check — the tree is out of sync; run `npm run media:sync`.");
    process.exit(1);
  }
  if (unfixable > 0 || contentBroken) {
    console.error("\n✗ media sync found problems that need a human decision");
    process.exit(1);
  }
  if (options.check) {
    console.log("\n✓ media tree in sync (check mode)");
    return;
  }
  if (!write) {
    console.log("\n✓ dry run complete (nothing written)");
    return;
  }
  // Only now — after every lesson passed its checks and the tree validated
  // cleanly — is anything written. Thumbnails first, because an in-memory
  // override already claims `thumb` exists while the bytes are still pending.
  //
  // Writing can still fail *after* this point (read-only record, full disk,
  // process killed). A clean verdict is not a transaction, so the commit phase
  // is guarded too: if any write throws, every file this run created or
  // overwrote is restored, so the tree is byte-identical to how it was found
  // rather than "canonicalised but with a thumbnail nobody references".
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const overwrittenFiles: Array<{ path: string; previous: Buffer }> = [];

  /**
   * Records what a write is about to do, reading any previous bytes through a
   * descriptor rather than by path.
   *
   * `fs.existsSync(path)` followed by `fs.readFileSync(path)` is a check-then-use
   * pair: the directory can be swapped between them, and the "previous bytes"
   * would then come from outside the tree. Here the parent is pinned and the read
   * goes through it, and the same handle is reused for the write below.
   */
  const remember = (
    parent: ReturnType<typeof openDir>,
    name: string,
    absolute: string,
  ): void => {
    const existing = fileExistsAt(parent, name);
    if (!existing) {
      createdFiles.push(absolute);
      return;
    }
    const previous = readFileAt(parent, name);
    if (previous === null) {
      createdFiles.push(absolute);
      return;
    }
    overwrittenFiles.push({ path: absolute, previous });
  };

  try {
    if (pendingThumbs.length > 0) {
      const mediaRootForWrites = resolveMediaRoot(paths.mediaRoot, { create: true });
      const mediaHandle = openDir(mediaRootForWrites);
      try {
        for (const thumb of pendingThumbs) {
          const parts = relativeParts(mediaRootForWrites, thumb.path);
          const leaf = parts.pop() as string;
          // Missing levels are created relative to the pinned root and recorded,
          // so a failed run can remove exactly what it created.
          const { dir, created } = ensureDirPath(mediaHandle, parts);
          try {
            for (const name of created) createdDirectories.push(path.join(mediaRootForWrites, name));
            remember(dir, leaf, path.join(mediaRootForWrites, ...parts, leaf));
            // `writeFileAt` creates with O_EXCL, or truncates only after the
            // descriptor is proven to be a regular file. No O_TRUNC on a path.
            writeFileAt(dir, leaf, thumb.buffer, { exclusive: false });
          } finally {
            dir.close();
          }
        }
      } finally {
        mediaHandle.close();
      }
    }
    for (const pending of pendingWrites) {
      const target = path.join(paths.contentRoot, "lessons", pending.file);
      const contentHandle = openDir(paths.contentRoot);
      try {
        remember(contentHandle, path.join("lessons", pending.file), target);
      } finally {
        contentHandle.close();
      }
      writeJson(paths.contentRoot, target, pending.lesson);
    }
  } catch (error) {
    const rolled = rollbackWrites(
      createdFiles,
      overwrittenFiles,
      createdDirectories,
      // A rollback deletes: confine it to the two trees this run may write.
      [paths.contentRoot, paths.mediaRoot],
    );
    // The original failure is reported first and in full — it is the cause.
    const report = formatRollbackReport(error, rolled);
    console.error("");
    for (const line of report.lines) console.error(`  ${line}`);
    process.exit(1);
  }
  if (pendingWrites.length > 0) {
    console.log(`\n  wrote ${pendingWrites.length} lesson file(s)`);
  }
  console.log("\n✓ media tree in sync");
}

void main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
