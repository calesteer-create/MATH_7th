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
import { defaultPaths, nowIso, readLessons, readQuizFiles, writeJson } from "../src/media/tree";
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

  for (const entry of readLessons(paths.contentRoot)) {
    const lesson = entry.value;
    const dir = path.join(lessonsDir, String(lesson.id));
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
      const filePath = path.join(dir, file);
      if (!fs.existsSync(filePath)) {
        summary.missing.push(`lessons/${lesson.id}/${file}`);
        nextImages.push(image);
        continue;
      }
      const buffer = fs.readFileSync(filePath);
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
      if (!fs.existsSync(thumbPath)) {
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

    // Orphan detection scoped to this lesson folder.
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!name.isFile() || !name.name.toLowerCase().endsWith(".webp")) continue;
        if (!nextImages.some((image) => image.file === name.name)) {
          summary.orphans.push(`lessons/${lesson.id}/${name.name}`);
        }
      }
    }

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
  // One pass, no partial state.
  for (const thumb of pendingThumbs) {
    fs.mkdirSync(path.dirname(thumb.path), { recursive: true });
    fs.writeFileSync(thumb.path, thumb.buffer);
  }
  for (const pending of pendingWrites) {
    writeJson(path.join(paths.contentRoot, "lessons", pending.file), pending.lesson);
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
