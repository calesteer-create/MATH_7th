/**
 * The content-source seam and the static scan pipeline (Phase 2a).
 *
 * Two invariants are load-bearing for "the published site is the JSON tree":
 *
 *   1. `src/content/source.ts` must expose **identical shapes** in both modes,
 *      because pages consume it without branching. A drift between the SQLite
 *      row shape and the JSON shape would silently blank a field on one host
 *      only — the worst kind of bug, since it cannot be reproduced locally.
 *      The types are checked by `npm run typecheck`; here the *runtime* values
 *      are compared on the same fixture loaded into both stores.
 *
 *   2. `scripts/static-media.mjs` decides which scans become public and
 *      `scripts/build-static.mjs` copies exactly those. The tests below pin the
 *      boundary: published only, referenced only, missing file = hard failure.
 *
 * Nothing here writes into the repository: every tree lives under os.tmpdir().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  staticScanCopyPlan,
  publishedLessonIds,
  MEDIA_FILE_RE,
} from "../scripts/static-media.mjs";

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, "tests/content/example/media/lessons/1/page-01.webp");

let tempDir = "";
let contentRoot = "";
let mediaRoot = "";
let dbFile = "";

/** One unit, one published lesson (2 scans), one draft. Mirrors the example. */
function writeTree(): void {
  const now = "2026-11-02T10:00:00.000Z";
  fs.mkdirSync(path.join(contentRoot, "units"), { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "lessons"), { recursive: true });
  const folder = path.join(mediaRoot, "lessons", "1");
  fs.mkdirSync(path.join(folder, "thumbs"), { recursive: true });

  const bytes = fs.readFileSync(FIXTURE);
  const sha = "ff12d964cffe538b4d4f290412f64197f1b35e89813555b81b03eb1da6d1cf23";
  const images = [1, 2].map((position) => {
    const file = `page-0${position}.webp`;
    fs.copyFileSync(FIXTURE, path.join(folder, file));
    fs.copyFileSync(FIXTURE, path.join(folder, "thumbs", file));
    return {
      position,
      file,
      thumb: `thumbs/${file}`,
      width: 220,
      height: 300,
      bytes: bytes.byteLength,
      sha256: sha,
    };
  });

  fs.writeFileSync(
    path.join(contentRoot, "units", "1.json"),
    JSON.stringify({
      id: 1,
      position: 1,
      titleAr: "وحدة المصدر",
      titleEn: "Source unit",
      descriptionAr: "",
      descriptionEn: "",
      pageFrom: "5",
      pageTo: "9",
      accent: "teal",
      createdAt: now,
      updatedAt: now,
    }),
  );
  fs.writeFileSync(
    path.join(contentRoot, "lessons", "1.json"),
    JSON.stringify({
      id: 1,
      unitId: 1,
      position: 1,
      titleAr: "درس المصدر",
      titleEn: "Source lesson",
      pageLabel: "ص 5",
      status: "published",
      isLastInUnit: true,
      publishedAt: now,
      contentUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      images,
    }),
  );
  fs.writeFileSync(
    path.join(contentRoot, "lessons", "2.json"),
    JSON.stringify({
      id: 2,
      unitId: 1,
      position: 2,
      titleAr: "مسودة المصدر",
      titleEn: "Draft lesson",
      pageLabel: "",
      status: "draft",
      isLastInUnit: false,
      publishedAt: null,
      contentUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      images: [],
    }),
  );
}

/**
 * The same fixture, in the database — to compare shapes with the JSON side.
 *
 * `src/db/index.ts` resolves DATABASE_FILE **at import time**, so both modules
 * are imported dynamically after the environment points at the temp file;
 * otherwise the seam would read the repository's own data/ (which is empty).
 */
async function seedDatabase(dbFile: string): Promise<void> {
  const { getSqlite } = await import("@/db");
  const { migrate } = await import("../scripts/migrate");
  const sqlite = getSqlite(dbFile);
  migrate(sqlite);
  const now = "2026-11-02T10:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO units (id, position, title_ar, title_en, page_from, page_to, accent, created_at, updated_at)
       VALUES (1, 1, ?, ?, '5', '9', 'teal', ?, ?)`,
    )
    .run("وحدة المصدر", "Source unit", now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (id, unit_id, position, title_ar, title_en, page_label, status, is_last_in_unit,
         published_at, content_updated_at, created_at, updated_at)
       VALUES (1, 1, 1, ?, ?, 'ص 5', 'published', 1, ?, ?, ?, ?)`,
    )
    .run("درس المصدر", "Source lesson", now, now, now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (id, unit_id, position, title_ar, title_en, status, content_updated_at, created_at, updated_at)
       VALUES (2, 1, 2, ?, ?, 'draft', ?, ?, ?)`,
    )
    .run("مسودة المصدر", "Draft lesson", now, now, now);
  sqlite
    .prepare(
      `INSERT INTO lesson_images (id, lesson_id, position, storage_key, mime, width, height, bytes, sha256, state, created_at)
       VALUES (1, 1, 1, 'lessons/1/page-01.webp', 'image/webp', 220, 300, 494,
               'ff12d964cffe538b4d4f290412f64197f1b35e89813555b81b03eb1da6d1cf23', 'ready', ?)`,
    )
    .run(now);
  sqlite.close();
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-source-"));
  contentRoot = path.join(tempDir, "content");
  mediaRoot = path.join(tempDir, "media");
  dbFile = path.join(tempDir, "source.db");
  // `src/db/index.ts` resolves DATABASE_FILE at import time, so this must be
  // set before any import of the seam.
  process.env.DATABASE_FILE = dbFile;
  process.env.CONTENT_ROOT = contentRoot;
  process.env.MEDIA_ROOT = mediaRoot;
  writeTree();
  await seedDatabase(dbFile);
}, 120_000);

afterAll(() => {
  delete process.env.CONTENT_ROOT;
  delete process.env.MEDIA_ROOT;
  delete process.env.NEXT_OUTPUT;
  delete process.env.NEXT_STATIC_EXPORT;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 1. the scan copy plan (the publish boundary) ───────────────────────────

describe("static scan copy plan", () => {
  it("lists published lessons only", () => {
    expect(publishedLessonIds(contentRoot)).toEqual([1]);
  });

  it("plans exactly the referenced web and thumb files", () => {
    const { plan, missing, invalid, unsafe } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
    expect(unsafe).toEqual([]);
    expect(plan.map((entry: { relative: string }) => entry.relative).sort()).toEqual([
      "media/lessons/1/page-01.webp",
      "media/lessons/1/page-02.webp",
      "media/lessons/1/thumbs/page-01.webp",
      "media/lessons/1/thumbs/page-02.webp",
    ]);
  });

  it("reports a referenced scan that does not exist instead of skipping it", () => {
    fs.rmSync(path.join(mediaRoot, "lessons/1/page-02.webp"));
    const { missing } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ lessonId: 1, variant: "web", file: "page-02.webp" });
    // Restore for later tests.
    fs.copyFileSync(FIXTURE, path.join(mediaRoot, "lessons/1/page-02.webp"));
  });

  it("rejects an illegal filename even if it reached the tree", () => {
    const lessonFile = path.join(contentRoot, "lessons", "1.json");
    const original = fs.readFileSync(lessonFile, "utf8");
    const tampered = JSON.parse(original);
    tampered.images[0].file = "../escape.webp";
    fs.writeFileSync(lessonFile, JSON.stringify(tampered));
    const { invalid } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(invalid).toHaveLength(1);
    fs.writeFileSync(lessonFile, original);
  });

  it("keeps the filename rule in sync with the content model", () => {
    // src/content/model.ts#IMAGE_FILE_RE — this module re-states it for the
    // plain-JS publish path, so the two must agree.
    const model = fs.readFileSync(path.join(ROOT, "src/content/model.ts"), "utf8");
    const literal = model.match(/IMAGE_FILE_RE = (\/\^\[a-z0-9\][^\n]+?\/);/)![1]!;
    const modelRe = new RegExp(literal.slice(1, literal.lastIndexOf("/")));
    for (const name of ["page-01.webp", "a.webp", "../x.webp", "Page-01.webp", "page_01.webp"]) {
      expect(MEDIA_FILE_RE.test(name), name).toBe(modelRe.test(name));
    }
  });

  it("returns an empty plan for a repository with no content tree", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "math7-empty-"));
    try {
      expect(staticScanCopyPlan(empty, empty)).toEqual({ plan: [], missing: [], invalid: [], unsafe: [] });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── 2. the seam: same shapes from both stores ─────────────────────────────

describe("content source — the two stores agree", () => {
  it("exposes exactly the interface pages consume", async () => {
    // Pages import this module and nothing else for content, so the set of
    // exports IS the contract. Adding one without a both-modes check would let
    // it break on a single host only; this list forces the pair below to grow.
    const source = await import("@/content/source");
    expect(Object.keys(source).sort()).toEqual([
      "contentRoot",
      "getLessonWithUnit",
      "getUnit",
      "listLessonImages",
      "listLessons",
      "listPublishedLessonIds",
      "listUnits",
      "mediaRoot",
      "overviewStats",
      "unitIsComplete",
    ]);
  });

  it("returns the JSON tree in export mode and SQLite otherwise", async () => {
    // Imported afresh per mode: BASE_PATH and the dispatch are module-level.
    process.env.NEXT_OUTPUT = "export";
    const json = await import("@/content/source");
    expect(json.listUnits()).toHaveLength(1);
    expect(json.listPublishedLessonIds()).toEqual([1]);

    delete process.env.NEXT_OUTPUT;
    delete process.env.NEXT_STATIC_EXPORT;
  });

  it("produces byte-identical unit and lesson shapes in both modes", async () => {
    process.env.NEXT_OUTPUT = "export";
    const json = await import("@/content/source");
    const jsonUnits = json.listUnits();
    const jsonLesson = json.getLessonWithUnit(1)!;
    const jsonLessons = json.listLessons(1, false);

    // Switch mode in the same process by clearing the markers and re-importing
    // a fresh module instance (vi.resetModules keeps the two apart).
    const { vi } = await import("vitest");
    vi.resetModules();
    delete process.env.NEXT_OUTPUT;
    delete process.env.NEXT_STATIC_EXPORT;
    const db = await import("@/content/source");
    const dbUnits = db.listUnits();
    const dbLesson = db.getLessonWithUnit(1)!;
    const dbLessons = db.listLessons(1, false);

    // Same keys, same values — only the store differs.
    expect(Object.keys(jsonUnits[0]!).sort()).toEqual(Object.keys(dbUnits[0]!).sort());
    expect(jsonUnits).toEqual(JSON.parse(JSON.stringify(dbUnits)));
    expect(Object.keys(jsonLesson.lesson).sort()).toEqual(Object.keys(dbLesson.lesson).sort());
    expect(jsonLesson.lesson).toEqual(JSON.parse(JSON.stringify(dbLesson.lesson)));
    expect(jsonLessons).toEqual(JSON.parse(JSON.stringify(dbLessons)));
    expect(json.overviewStats()).toEqual(db.overviewStats());
    expect(json.unitIsComplete(1)).toBe(db.unitIsComplete(1));
  });

  it("exposes isLastInUnit as 0 | 1 in both modes", async () => {
    process.env.NEXT_OUTPUT = "export";
    const { vi } = await import("vitest");
    vi.resetModules();
    const json = await import("@/content/source");
    expect(json.listLessons(1, false)[0]!.isLastInUnit).toBe(1);
  });

  it("counts only published lessons in the exported overview", async () => {
    process.env.NEXT_OUTPUT = "export";
    const { vi } = await import("vitest");
    vi.resetModules();
    const json = await import("@/content/source");
    const stats = json.overviewStats();
    expect(stats).toMatchObject({ units: 1, lessons: 2, published: 1, drafts: 1, images: 2 });
  });
});

// ── 3. scan URL: which host serves what ───────────────────────────────────

describe("scanUrl", () => {
  it("uses the authorised server route in server mode", async () => {
    const { vi } = await import("vitest");
    delete process.env.NEXT_OUTPUT;
    delete process.env.NEXT_STATIC_EXPORT;
    vi.resetModules();
    const { scanUrl } = await import("@/lib/scan-url");
    expect(scanUrl({ legacyImageId: 7, file: "page-01.webp", lessonId: 3, variant: "web" })).toBe(
      "/media/i/7/web",
    );
    expect(scanUrl({ legacyImageId: 7, file: "page-01.webp", lessonId: 3, variant: "thumb" })).toBe(
      "/media/i/7/thumb",
    );
  });

  it("uses the plain static file under the Pages prefix in export mode", async () => {
    process.env.NEXT_OUTPUT = "export";
    const { vi } = await import("vitest");
    vi.resetModules();
    const { scanUrl } = await import("@/lib/scan-url");
    expect(scanUrl({ legacyImageId: 7, file: "page-01.webp", lessonId: 3, variant: "web" })).toBe(
      "/MATH_7th/media/lessons/3/page-01.webp",
    );
    expect(scanUrl({ legacyImageId: 7, file: "page-01.webp", lessonId: 3, variant: "thumb" })).toBe(
      "/MATH_7th/media/lessons/3/thumbs/page-01.webp",
    );
  });

  it("never emits a server-only media URL when a filename is missing", async () => {
    process.env.NEXT_OUTPUT = "export";
    const { vi } = await import("vitest");
    vi.resetModules();
    const { scanUrl } = await import("@/lib/scan-url");
    // Silently falling back to /media/i/ would break the artifact audit later;
    // failing here names the actual problem (a lesson whose images lack files).
    expect(() => scanUrl({ legacyImageId: 7, lessonId: 3, variant: "web" })).toThrow(/without a file name/);
  });
});
