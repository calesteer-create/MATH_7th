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
import { isLegalMediaName } from "../src/media/naming";
import { buildReferenceIndex, collectedQuizReferences } from "../src/media/sync-helpers";
import { defaultPaths, nowIso, readLessons, readQuizFiles, validatePaths, writeJson } from "../src/media/tree";
import type { LessonContent, LessonImageContent } from "../src/content/model";

/** Validator codes that `media:sync` fixes by rewriting the lesson record. */
const REPAIRABLE_CODES = new Set([
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
  };

  console.log("MATH 7TH — media sync");
  console.log(`  content: ${paths.contentRoot}`);
  console.log(`  media:   ${paths.mediaRoot}${write ? "" : " (read-only run)"}\n`);

  const lessonsDir = path.join(paths.mediaRoot, "lessons");
  const changedLessons: LessonContent[] = [];

  for (const entry of readLessons(paths.contentRoot)) {
    const lesson = entry.value;
    const dir = path.join(lessonsDir, String(lesson.id));
    const nextImages: LessonImageContent[] = [];
    let changed = false;

    for (const image of lesson.images) {
      if (!isLegalMediaName(image.file)) {
        summary.errors.push(`lessons/${entry.file}: illegal filename ${JSON.stringify(image.file)}`);
        nextImages.push(image);
        continue;
      }
      const filePath = path.join(dir, image.file);
      if (!fs.existsSync(filePath)) {
        summary.missing.push(`lessons/${lesson.id}/${image.file}`);
        nextImages.push(image);
        continue;
      }
      const buffer = fs.readFileSync(filePath);
      if (detectMime(buffer) !== "image/webp") {
        summary.errors.push(`lessons/${lesson.id}/${image.file} is not a WebP file`);
        nextImages.push(image);
        continue;
      }
      let meta: { width?: number; height?: number };
      try {
        meta = await sharp(buffer).metadata();
      } catch (error) {
        summary.errors.push(
          `lessons/${lesson.id}/${image.file} cannot be decoded: ${(error as Error).message}`,
        );
        nextImages.push(image);
        continue;
      }
      const refreshed: LessonImageContent = {
        ...image,
        thumb: `thumbs/${image.file}`,
        width: meta.width ?? image.width,
        height: meta.height ?? image.height,
        bytes: image.bytes ?? buffer.byteLength,
        sha256: sha256Hex(buffer),
      };
      const thumbPath = path.join(dir, "thumbs", image.file);
      if (!fs.existsSync(thumbPath)) {
        const thumbBuffer = await sharp(buffer)
          .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY, effort: 4 })
          .toBuffer();
        summary.thumbnailsCreated += 1;
        if (write) {
          fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
          fs.writeFileSync(thumbPath, thumbBuffer);
        }
      }
      if (
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
      changedLessons.push({
        ...lesson,
        images: nextImages,
        contentUpdatedAt: lesson.contentUpdatedAt,
        updatedAt: nowIso(),
      });
      if (write) {
        writeJson(path.join(paths.contentRoot, "lessons", entry.file), changedLessons[changedLessons.length - 1]);
      }
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

  const needsWork = summary.thumbnailsCreated + summary.recordsUpdated > 0;

  console.log(
    `\n  thumbnails created: ${summary.thumbnailsCreated}\n` +
      `  image records refreshed: ${summary.recordsUpdated} in ${summary.lessonsChanged} lesson(s)\n` +
      `  orphans: ${summary.orphans.length} · missing: ${summary.missing.length} · errors: ${summary.errors.length}`,
  );

  // Non-strict: IMAGE_ORPHAN is a warning for a human to review, never a
  // deletion — escalating it would make "unused file exists" look fatal.
  const validation = validatePaths(paths, false);
  console.log(`  content validation: ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`);
  const pendingDerivedFieldErrors =
    needsWork && !write
      ? validation.errors.every((issue) => REPAIRABLE_CODES.has(issue.code))
      : false;
  const shown = pendingDerivedFieldErrors ? validation.warnings : validation.errors;
  for (const issue of shown.slice(0, 10)) {
    console.log(`   [${issue.code}] ${issue.path} — ${issue.message}`);
  }
  if (pendingDerivedFieldErrors) {
    console.log("   (derived-field errors above are exactly what a write run repairs)");
  }

  // Errors the sync cannot repair always fail the run.
  const unfixable = summary.errors.length + summary.missing.length;
  const contentBroken = validation.errors.length > 0 && !pendingDerivedFieldErrors;

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
  console.log(write ? "\n✓ media tree in sync" : "\n✓ dry run complete (nothing written)");
}

void main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
