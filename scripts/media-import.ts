#!/usr/bin/env node
/**
 * `npm run media:import` — local image import for lesson pages (PR 5).
 *
 * Takes photos/scans from a folder on THIS machine, converts them to WebP, and
 * writes only the two committed renditions into public/media/lessons/<id>/.
 * The originals are never copied into the repository — they stay where they
 * are, which is the project rule ("الصور الأصلية تبقى على جهازي محليًا").
 *
 *   npm run media:import -- --lesson 1 --from ~/scans/lesson-1
 *   npm run media:import -- --lesson 1 --from ~/scans/lesson-1 --dry-run
 *   npm run media:import -- --lesson 1 --from ~/scans/lesson-1 --no-record
 *
 * By default the lesson JSON is updated with the imported records (position,
 * file, thumb, width, height, bytes, sha256) so the tree stays valid, and any
 * existing image that would be dropped is reported instead of deleted.
 */

import fs from "node:fs";
import path from "node:path";
import { importImageIntoLesson } from "../src/media/import";
import { describeBytes } from "../src/media/format";
import type { MediaError } from "../src/media/process";
import { defaultPaths, nowIso, readLesson, validatePaths, writeLesson } from "../src/media/tree";
import type { LessonContent } from "../src/content/model";

const SOURCE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

interface Options {
  lessonId: number | null;
  from: string | null;
  dryRun: boolean;
  record: boolean;
  mediaRoot: string | null;
  contentRoot: string | null;
  allowEmptyLesson: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    lessonId: null,
    from: null,
    dryRun: false,
    record: true,
    mediaRoot: null,
    contentRoot: null,
    allowEmptyLesson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--lesson":
        options.lessonId = Number(argv[++i]);
        break;
      case "--from":
        options.from = argv[++i] ?? null;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-record":
        options.record = false;
        break;
      case "--media":
        options.mediaRoot = argv[++i] ?? null;
        break;
      case "--content":
        options.contentRoot = argv[++i] ?? null;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith("--")) fail(`unknown option ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`media:import — convert local images and add them to a lesson

  --lesson <id>      lesson id (file content/lessons/<id>.json); required
  --from <dir>       folder with the original images (stays untouched); required
  --dry-run          validate and encode, write nothing
  --no-record        write the WebP files but do not touch the lesson JSON
  --media <dir>      override the media root (default: public/media)
  --content <dir>    override the content root (default: content)
  -h, --help         this text

Supported inputs: JPEG, PNG, WebP. Each file is validated (magic bytes, size,
dimensions), oriented by EXIF, converted to WebP (≤2200px) plus a ≤480px
thumbnail, and EXIF/GPS is discarded. Files are imported in name order.
`);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.lessonId || !Number.isInteger(options.lessonId) || options.lessonId < 1) {
    fail("--lesson <id> is required (a positive integer)");
  }
  if (!options.from) fail("--from <dir> is required");
  const sourceDir = path.resolve(options.from);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    fail(`--from ${options.from} is not a directory`);
  }

  const paths = defaultPaths();
  if (options.contentRoot) paths.contentRoot = path.resolve(options.contentRoot);
  if (options.mediaRoot) paths.mediaRoot = path.resolve(options.mediaRoot);

  const lessonEntry = fs.existsSync(path.join(paths.contentRoot, "lessons", `${options.lessonId}.json`))
    ? readLesson(paths.contentRoot, options.lessonId)
    : null;
  if (!lessonEntry && options.record) {
    fail(
      `lesson ${options.lessonId} does not exist at content/lessons/${options.lessonId}.json.\n` +
        "Create the lesson first (admin panel or by hand), or pass --no-record to only convert files.",
    );
  }

  const files = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    fail(`no ${[...SOURCE_EXTENSIONS].join("/")} files found in ${options.from}`);
  }

  console.log("MATH 7TH — media import");
  console.log(`  lesson: ${options.lessonId}`);
  console.log(`  source: ${sourceDir} (originals are NOT copied into the repository)`);
  console.log(`  media:  ${paths.mediaRoot}`);
  console.log(`  files:  ${files.length}${options.dryRun ? " (dry run — nothing will be written)" : ""}\n`);

  const existing = lessonEntry?.value.images ? [...lessonEntry.value.images] : [];
  const imported = [] as LessonContent["images"];
  const failures: Array<{ file: string; code: string; message: string }> = [];

  for (const name of files) {
    const full = path.join(sourceDir, name);
    try {
      const result = await importImageIntoLesson({
        mediaRoot: paths.mediaRoot,
        lessonId: options.lessonId,
        source: fs.readFileSync(full),
        label: path.basename(name, path.extname(name)),
        existing: [...existing, ...imported],
        dryRun: options.dryRun,
      });
      const before = [...existing, ...imported].find((image) => image.sha256 === result.image.sha256);
      if (!before) imported.push(result.image);
      console.log(
        `  ✓ ${name} → ${result.image.file}` +
          `${result.reused ? " (identical content already present)" : ""}` +
          ` · ${result.image.width}×${result.image.height} · ${describeBytes(result.processed.web.byteLength)}`,
      );
    } catch (error) {
      const mediaError = error as MediaError;
      failures.push({ file: name, code: mediaError.code ?? "ERROR", message: mediaError.message });
      console.error(`  ✗ ${name} — ${mediaError.code ?? "ERROR"}: ${mediaError.message}`);
    }
  }

  if (options.record && lessonEntry && imported.length > 0 && !options.dryRun) {
    const nextImages = [...existing, ...imported]
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((image, index) => ({ ...image, position: index + 1 }));
    const removed = existing.filter((image) => !nextImages.some((next) => next.file === image.file));
    if (removed.length > 0) {
      console.log(
        `\n  ! ${removed.length} existing image record(s) are no longer in the lesson ` +
          `(${removed.map((image) => image.file).join(", ")}). No files were deleted.`,
      );
    }
    const updated: LessonContent = {
      ...lessonEntry.value,
      images: nextImages,
      updatedAt: nowIso(),
      contentUpdatedAt: nowIso(),
    };
    writeLesson(paths.contentRoot, updated);
    console.log(`\n  ✓ updated content/lessons/${options.lessonId}.json (${nextImages.length} images)`);
  }

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} file(s) were rejected:`);
    for (const failure of failures) console.error(`   ${failure.file}: ${failure.code} — ${failure.message}`);
  }

  const validation = validatePaths(paths);
  console.log(
    `\n  content validation: ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`,
  );
  for (const issue of validation.errors.slice(0, 10)) {
    console.log(`   [${issue.code}] ${issue.path} — ${issue.message}`);
  }
  if (validation.errors.length > 0) {
    console.error("\n✗ content tree is not valid after the import");
    process.exit(1);
  }
  console.log(options.dryRun ? "\n✓ dry run complete" : "\n✓ import complete");
}

void main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
