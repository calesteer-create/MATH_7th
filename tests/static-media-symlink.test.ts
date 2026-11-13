/**
 * Regression tests for the media publish boundary.
 *
 * `scripts/static-media.mjs` decides which bytes become public on GitHub Pages.
 * The original implementation asked `fs.existsSync()` and then `fs.copyFileSync()`:
 * both follow symbolic links, so a link planted at a scan path (or at the lesson
 * folder, or at `thumbs/`) published whatever it pointed at — including a file
 * outside the media root. All four cases below reproduced that leak before the
 * fix; each one now fails the build with `unsafe` before a byte is copied.
 *
 * The cases are tested twice, at the two layers that matter:
 *   - the plan, which must refuse the link and say why;
 *   - the build, which must stop before writing anything into out/.
 *
 * Legitimate layouts are tested next to them: real files must still publish, so
 * the fix cannot be "refuse everything" and quietly stop shipping scans.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { staticScanCopyPlan, publishedLessonIds } from "../scripts/static-media.mjs";

const ROOT = process.cwd();
const EXAMPLE = path.join(ROOT, "tests/content/example");
const SECRET = "SECRET-BYTES-OUTSIDE-THE-MEDIA-ROOT";

let work = "";
let contentRoot = "";
let mediaRoot = "";
let lessonDir = "";
let secretDir = "";

/** Writes a minimal published lesson that references two pages. */
function writeLesson(id: number, files: string[], status: unknown = "published"): void {
  fs.writeFileSync(
    path.join(contentRoot, "lessons", `${id}.json`),
    JSON.stringify({
      id,
      unitId: 1,
      position: 1,
      titleAr: "مثال مرجعي",
      titleEn: "Reference example",
      pageLabel: "1",
      status,
      images: files.map((file, index) => ({
        position: index + 1,
        file,
        thumb: `thumbs/${file}`,
        width: 220,
        height: 300,
        bytes: 494,
        sha256: "0".repeat(64),
      })),
    }),
  );
}

/** Real scans for lesson 1, laid out exactly as the content tree expects. */
function writeRealScans(id = 1, files = ["page-01.webp", "page-02.webp"]): void {
  const dir = path.join(mediaRoot, "lessons", String(id));
  fs.mkdirSync(path.join(dir, "thumbs"), { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(EXAMPLE, "media/lessons/1", file), path.join(dir, file));
    fs.copyFileSync(path.join(EXAMPLE, "media/lessons/1/thumbs", file), path.join(dir, "thumbs", file));
  }
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "static-media-"));
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  contentRoot = path.join(work, "content");
  mediaRoot = path.join(work, "media");
  lessonDir = path.join(mediaRoot, "lessons", "1");
  secretDir = path.join(work, "secret");
  fs.mkdirSync(path.join(contentRoot, "units"), { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "lessons"), { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(secretDir, "leak.txt"), SECRET);
  fs.copyFileSync(path.join(EXAMPLE, "content/units/1.json"), path.join(contentRoot, "units", "1.json"));
  writeRealScans();
  writeLesson(1, ["page-01.webp", "page-02.webp"]);
});

describe("the plan refuses every symlink shape", () => {
  it("publishes real files — the boundary is a filter, not a wall", () => {
    const { plan, unsafe, missing, invalid } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(unsafe).toEqual([]);
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
    expect(plan.map((entry) => entry.relative).sort()).toEqual([
      "media/lessons/1/page-01.webp",
      "media/lessons/1/page-02.webp",
      "media/lessons/1/thumbs/page-01.webp",
      "media/lessons/1/thumbs/page-02.webp",
    ]);
  });

  it("carries the bytes it validated, so the copy cannot re-open a path", () => {
    const { plan } = staticScanCopyPlan(contentRoot, mediaRoot);
    const web = plan.find((entry) => entry.relative === "media/lessons/1/page-01.webp");
    expect(web?.bytes).toBeInstanceOf(Buffer);
    expect(web?.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(web?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(web?.sha256).not.toBe("0".repeat(64));
  });

  it("refuses a symlinked scan file that points outside the media root", () => {
    fs.rmSync(path.join(lessonDir, "page-01.webp"));
    fs.symlinkSync(path.join(secretDir, "leak.txt"), path.join(lessonDir, "page-01.webp"));

    const { plan, unsafe } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0]).toMatchObject({ lessonId: 1, variant: "web", file: "page-01.webp" });
    expect(unsafe[0]?.reason).toMatch(/symbolic link/);
    // The linked file is not planned, and it is not reported as "missing" either:
    // it exists, it is simply not ours to publish.
    expect(plan.some((entry) => entry.relative.endsWith("/page-01.webp") && entry.variant === "web")).toBe(false);
  });

  it("refuses a symlinked scan file that points inside the media root but at another lesson", () => {
    // An in-root link is not "external", yet it would still publish lesson 9's
    // page under lesson 1 — a mis-attributed scan, which is a content error.
    fs.mkdirSync(path.join(mediaRoot, "lessons", "9"), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "lessons", "9", "page-01.webp"), "OTHER-LESSON");
    fs.rmSync(path.join(lessonDir, "page-01.webp"));
    fs.symlinkSync("../9/page-01.webp", path.join(lessonDir, "page-01.webp"));

    const { unsafe, plan } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0]).toMatchObject({ lessonId: 1, variant: "web", file: "page-01.webp" });
    expect(plan.every((entry) => !entry.relative.endsWith("/page-01.webp") || entry.variant === "thumb")).toBe(true);
  });

  it("refuses a symlinked lesson folder", () => {
    const outside = path.join(work, "outside-lesson");
    fs.mkdirSync(path.join(outside, "thumbs"), { recursive: true });
    for (const file of ["page-01.webp", "page-02.webp"]) {
      fs.writeFileSync(path.join(outside, file), SECRET);
      fs.writeFileSync(path.join(outside, "thumbs", file), SECRET);
    }
    fs.rmSync(lessonDir, { recursive: true });
    fs.symlinkSync(outside, lessonDir);

    const { plan, unsafe } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(plan).toEqual([]);
    expect(unsafe).toHaveLength(4);
    expect(unsafe.every((entry) => /symbolic link|not a directory/.test(entry.reason))).toBe(true);
  });

  it("refuses a symlinked thumbs folder", () => {
    const outside = path.join(work, "outside-thumbs");
    fs.mkdirSync(outside, { recursive: true });
    for (const file of ["page-01.webp", "page-02.webp"]) fs.writeFileSync(path.join(outside, file), SECRET);
    fs.rmSync(path.join(lessonDir, "thumbs"), { recursive: true });
    fs.symlinkSync(outside, path.join(lessonDir, "thumbs"));

    const { plan, unsafe } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(unsafe.map((entry) => entry.variant)).toEqual(["thumb", "thumb"]);
    expect(plan.map((entry) => entry.variant)).toEqual(["web", "web"]);
  });

  it("refuses a symlinked lessons folder inside the media root", () => {
    const outside = path.join(work, "outside-lessons");
    fs.renameSync(path.join(mediaRoot, "lessons"), outside);
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons"));

    expect(() => staticScanCopyPlan(contentRoot, mediaRoot)).toThrow(/symbolic link/);
  });

  it("refuses a FIFO or other non-regular file at a scan path", () => {
    // Not a link, but still not a file we may publish. `readFileAt` refuses it
    // by `fstat` on the descriptor — and does not block, which is why the open
    // carries O_NONBLOCK.
    const fifoPath = path.join(lessonDir, "page-01.webp");
    fs.rmSync(fifoPath);
    const made = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    if (made.status !== 0) return; // no mkfifo on this platform: nothing to test
    const { unsafe, plan } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(unsafe).toHaveLength(1);
    expect(plan.some((entry) => entry.variant === "web" && entry.relative.includes("page-01"))).toBe(false);
  });
});

describe("the plan never lets malformed content through silently", () => {
  it("throws on invalid JSON instead of skipping the lesson", () => {
    fs.writeFileSync(path.join(contentRoot, "lessons", "1.json"), '{"id":1,');
    expect(() => publishedLessonIds(contentRoot)).toThrow(/not valid JSON/);
  });

  it("throws on an unknown status instead of treating it as a draft", () => {
    writeLesson(1, ["page-01.webp"], "Published");
    expect(() => publishedLessonIds(contentRoot)).toThrow(/expected "published" or "draft"/);
  });

  it("throws when the filename and the declared id disagree", () => {
    // 1.json claiming to be lesson 5 would publish lesson 1's scans under the
    // wrong id; `content:validate` rejects it, and the build must not "fix" it.
    writeLesson(5, ["page-01.webp"]);
    fs.rmSync(path.join(contentRoot, "lessons", "1.json"));
    fs.renameSync(path.join(contentRoot, "lessons", "5.json"), path.join(contentRoot, "lessons", "1.json"));
    expect(() => publishedLessonIds(contentRoot)).toThrow(/declares id 5/);
  });

  it("throws when a lesson file is not named <lessonId>.json", () => {
    fs.writeFileSync(path.join(contentRoot, "lessons", "lesson-one.json"), JSON.stringify({ id: 1, status: "published" }));
    expect(() => publishedLessonIds(contentRoot)).toThrow(/not named <lessonId>\.json/);
  });

  it("throws when a lesson file is a symlink", () => {
    fs.rmSync(path.join(contentRoot, "lessons", "1.json"));
    fs.writeFileSync(path.join(work, "outside.json"), JSON.stringify({ id: 1, status: "published", images: [] }));
    fs.symlinkSync(path.join(work, "outside.json"), path.join(contentRoot, "lessons", "1.json"));
    expect(() => publishedLessonIds(contentRoot)).toThrow(/symbolic link/);
  });

  it("reports a non-canonical filename as invalid rather than publishing it", () => {
    writeLesson(1, ["PAGE-01.WEBP", "../escape.webp"]);
    const { plan, invalid } = staticScanCopyPlan(contentRoot, mediaRoot);
    expect(plan).toEqual([]);
    expect(invalid.map((entry) => entry.file)).toEqual(["PAGE-01.WEBP", "../escape.webp"]);
  });

  it("throws when images is not a list", () => {
    writeLesson(1, ["page-01.webp"]);
    const file = path.join(contentRoot, "lessons", "1.json");
    const lesson = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...lesson, images: "page-01.webp" }));
    expect(() => staticScanCopyPlan(contentRoot, mediaRoot)).toThrow(/images is not a list/);
  });
});

describe("the build stops before publishing an unsafe source", () => {
  const OUT = path.join(ROOT, "out");

  function runBuild() {
    const database = path.join(work, "build.db");
    return spawnSync(process.execPath, ["scripts/build-static.mjs"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_FILE: database, CONTENT_ROOT: contentRoot, MEDIA_ROOT: mediaRoot },
      encoding: "utf8",
      timeout: 240_000,
    });
  }

  it("fails on a symlinked scan and leaves no media in out/", () => {
    fs.rmSync(path.join(lessonDir, "page-01.webp"));
    fs.symlinkSync(path.join(secretDir, "leak.txt"), path.join(lessonDir, "page-01.webp"));

    const result = runBuild();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/refusing to publish unsafe media source/);
    // The refusal happens before the copy loop: nothing from the media tree
    // exists in the artefact, so the secret cannot be in the published output.
    expect(fs.existsSync(path.join(OUT, "media"))).toBe(false);
  }, 300_000);

  it("publishes real files and never the decoy that sat outside the media root", () => {
    const result = runBuild();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const published = path.join(OUT, "media/lessons/1/page-01.webp");
    expect(fs.existsSync(published)).toBe(true);
    expect(fs.readFileSync(published, "utf8")).not.toContain(SECRET);
    expect(fs.readFileSync(published).subarray(0, 4).toString("ascii")).toBe("RIFF");
  }, 300_000);
});
