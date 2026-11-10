import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { MediaError, inspectWebp, processSourceImage, sha256Hex } from "@/media/process";
import { checkDeletion, buildReferenceIndex, collectQuizSourceImages, referencedFiles } from "@/media/references";
import { importImageIntoLesson, listLessonMediaFiles } from "@/media/import";
import type { LessonImageContent } from "@/content/model";
import { validateLesson } from "@/content/validate";

/**
 * These are behavioural tests on real image bytes: a JPEG carrying EXIF/GPS is
 * actually encoded, the output is re-opened with sharp, and the assertions are
 * about what is inside the file — not about which function was called.
 */

/** Neutral technical fixture: a grid, no curriculum content. */
async function makeJpeg(width = 1600, height = 2200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f5f5f0"/>
    <g stroke="#999" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 180}" x2="${width}" y2="${i * 180}"/>`).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/** A JPEG whose EXIF block contains a GPS position and a description. */
async function makeGeoTaggedJpeg(width = 800, height = 1000): Promise<Buffer> {
  return sharp(await makeJpeg(width, height))
    .withExif({
      IFD0: { ImageDescription: "phone photo", Make: "TestPhone", Model: "X1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "33/1 30/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "36/1 17/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
}

function exifGpsStrings(buffer: Buffer): string[] {
  // Raw scan for the EXIF marker and GPS tags — independent of sharp's parser,
  // so a regression in the strip cannot hide behind the same library.
  const latin = buffer.toString("latin1");
  const found: string[] = [];
  if (/Exif\0\0/.test(latin)) found.push("Exif header");
  if (/GPSLatitude|GPSLongitude|GPSLatitudeRef/.test(latin)) found.push("GPS tags");
  if (/TestPhone/.test(latin)) found.push("Make");
  return found;
}

describe("processSourceImage — conversion and metadata strip", () => {
  it("converts a JPEG to WebP at both sizes and reports honest dimensions", async () => {
    const source = await makeJpeg(1600, 2200);
    const result = await processSourceImage(source);

    const web = await inspectWebp(result.web);
    const thumb = await inspectWebp(result.thumb);
    expect(web.format).toBe("webp");
    expect(thumb.format).toBe("webp");
    expect(result.width).toBe(1600);
    expect(result.height).toBe(2200);
    expect(web.width).toBe(1600);
    expect(thumb.width).toBeLessThanOrEqual(480);
    expect(result.sha256).toBe(sha256Hex(result.web));
    expect(result.sourceBytes).toBe(source.byteLength);
    // Thumbnail and page are different files.
    expect(result.thumbSha256).not.toBe(result.sha256);
  });

  it("strips GPS and EXIF from a geo-tagged photo (verified on the raw bytes)", async () => {
    const geo = await makeGeoTaggedJpeg();
    // Guard the fixture: the input must really contain what we claim.
    expect(exifGpsStrings(geo).length).toBeGreaterThan(0);

    const result = await processSourceImage(geo);
    for (const buffer of [result.web, result.thumb]) {
      const latin = buffer.toString("latin1");
      expect(latin).not.toMatch(/Exif\0\0/);
      expect(latin).not.toMatch(/GPSLatitude|GPSLongitude|TestPhone/);
      const meta = await sharp(buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
  });

  it("bakes EXIF orientation into the pixels before discarding it", async () => {
    // Orientation 6 = rotate 90° clockwise; after .rotate() width/height swap.
    const source = await sharp(await makeJpeg(600, 900))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await processSourceImage(source);
    expect(result.width).toBeGreaterThan(result.height);
  });

  it("downscales an oversized page but keeps the aspect ratio", async () => {
    const result = await processSourceImage(await makeJpeg(4000, 5000));
    expect(result.width).toBeLessThanOrEqual(2200);
    expect(Math.abs(result.width / result.height - 4000 / 5000)).toBeLessThan(0.01);
  });

  it("does not upscale a small (but legal) image", async () => {
    const result = await processSourceImage(await makeJpeg(400, 500));
    expect(result.width).toBe(400);
    expect(result.height).toBe(500);
  });

  it("rejects a non-image with a stable error code", async () => {
    await expect(processSourceImage(Buffer.from("<html>nope</html>"))).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects an image above the byte limit", async () => {
    const source = await makeJpeg(600, 600);
    await expect(processSourceImage(source, { maxBytes: 100 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects an image below the minimum dimensions", async () => {
    await expect(processSourceImage(await makeJpeg(40, 40))).rejects.toBeInstanceOf(MediaError);
  });
});

describe("importImageIntoLesson — writing to the media tree", () => {
  let mediaRoot: string;

  beforeEach(() => {
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "math7-import-"));
  });
  afterEach(() => {
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  it("writes exactly two files and never the original", async () => {
    const source = await makeGeoTaggedJpeg(1200, 1600);
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 7,
      source,
      label: "page 01",
    });

    expect(result.image.file).toBe("page-01.webp");
    expect(result.image.thumb).toBe("thumbs/page-01.webp");
    expect(result.reused).toBe(false);

    const dir = path.join(mediaRoot, "lessons", "7");
    expect(fs.existsSync(path.join(dir, "page-01.webp"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "thumbs", "page-01.webp"))).toBe(true);
    // The source bytes must exist nowhere in the tree.
    const all = fs.readdirSync(dir, { recursive: true }) as string[];
    expect(all.filter((name) => /\.(jpe?g|png)$/i.test(name))).toEqual([]);
    for (const name of all) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      expect(fs.readFileSync(full)).not.toEqual(source);
    }
    expect(validateLessonImages(result.image).issues).toEqual([]);
  });

  it("is idempotent: re-importing identical content reuses the filename", async () => {
    const source = await makeJpeg(900, 1200);
    const first = await importImageIntoLesson({ mediaRoot, lessonId: 3, source, label: "page 01" });
    const second = await importImageIntoLesson({
      mediaRoot,
      lessonId: 3,
      source,
      label: "page 01",
      existing: [first.image],
    });
    expect(second.reused).toBe(true);
    expect(second.image.file).toBe(first.image.file);
    expect(listLessonMediaFiles(mediaRoot, 3)).toEqual(["page-01.webp"]);
  });

  it("never overwrites a different page with the same label", async () => {
    const a = await importImageIntoLesson({
      mediaRoot,
      lessonId: 4,
      source: await makeJpeg(700, 900),
      label: "page 01",
    });
    const b = await importImageIntoLesson({
      mediaRoot,
      lessonId: 4,
      source: await makeJpeg(701, 900),
      label: "page 01",
      existing: [a.image],
    });
    expect(a.image.file).toBe("page-01.webp");
    expect(b.image.file).toBe("page-01-2.webp");
    expect(b.image.position).toBe(2);
    // Different bytes were preserved in both files.
    const dir = path.join(mediaRoot, "lessons", "4");
    expect(fs.readFileSync(path.join(dir, "page-01.webp"))).not.toEqual(
      fs.readFileSync(path.join(dir, "page-01-2.webp")),
    );
  });

  it("falls back to a positional name for an Arabic-only label", async () => {
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 5,
      source: await makeJpeg(700, 900),
      label: "صفحة ١",
    });
    expect(result.image.file).toBe("page-01.webp");
  });

  it("does not write anything in dry-run mode", async () => {
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 9,
      source: await makeJpeg(700, 900),
      dryRun: true,
    });
    expect(result.image.file).toBe("page-01.webp");
    expect(fs.existsSync(path.join(mediaRoot, "lessons", "9"))).toBe(false);
  });

  it("rejects a path-traversal lesson id", async () => {
    await expect(
      importImageIntoLesson({ mediaRoot, lessonId: Number("../../etc"), source: await makeJpeg(300, 300) }),
    ).rejects.toThrow(/invalid lesson id/);
  });

  it("assigns increasing positions", async () => {
    const existing: LessonImageContent[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await importImageIntoLesson({
        mediaRoot,
        lessonId: 11,
        source: await makeJpeg(300 + index, 300),
        existing,
      });
      existing.push(result.image);
      expect(result.image.position).toBe(index + 1);
    }
    expect(listLessonMediaFiles(mediaRoot, 11)).toEqual(["page-01.webp", "page-02.webp", "page-03.webp"]);
  });
});

/** Runs the imported record through the real content-model validator. */
function validateLessonImages(image: LessonImageContent): { issues: Array<{ code: string }> } {
  const lesson = {
    id: 1,
    unitId: 1,
    position: 1,
    titleAr: "اختبار",
    titleEn: "",
    pageLabel: "",
    status: "draft",
    isLastInUnit: false,
    publishedAt: null,
    contentUpdatedAt: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    images: [image],
  };
  return validateLesson(lesson, "lessons/1.json");
}

describe("reference tracking — never delete a used image", () => {
  const lessons = [
    {
      id: 1,
      images: [
        { file: "page-01.webp" } as LessonImageContent,
        { file: "page-02.webp" } as LessonImageContent,
      ],
    },
    { id: 2, images: [{ file: "page-01.webp" } as LessonImageContent] },
  ];
  const index = buildReferenceIndex(lessons);

  it("refuses to delete an image a lesson still lists", () => {
    const verdict = checkDeletion({ lessonId: 1, file: "page-01.webp" }, index);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("referenced_by_lesson");
    expect(verdict.detail).toContain("lesson 1");
  });

  it("reports the same filename being used by another lesson, without blocking", () => {
    // lesson 3/page-01.webp does not exist; lessons 1 and 2 both use the name
    // in their own folders. Deleting lesson 3's would-be file is allowed, but
    // the shared name is surfaced so a human can double-check.
    const verdict = checkDeletion({ lessonId: 3, file: "page-01.webp" }, index);
    expect(verdict.allowed).toBe(true);
    expect(verdict.sameNameInLessons).toEqual([1, 2]);
  });

  it("allows deleting an image nothing references", () => {
    const verdict = checkDeletion({ lessonId: 3, file: "page-99.webp" }, index);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("not_referenced");
  });

  it("refuses to delete an image quoted by a quiz question", () => {
    const verdict = checkDeletion({ lessonId: 5, file: "page-42.webp" }, index, [
      { scope: "lesson", lessonId: 5, unitId: null, sourceImages: ["page-42.webp"] },
    ]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("referenced_by_quiz");
    expect(verdict.quizReferences).toBe(1);
  });

  it("refuses illegal names outright rather than normalising them", () => {
    for (const file of ["../page.webp", "Page.webp", "page.png", "a/b.webp"]) {
      const verdict = checkDeletion({ lessonId: 1, file }, index);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("illegal_name");
    }
  });

  it("collects sourceImage values out of nested quiz JSON", () => {
    const quiz = {
      versions: [
        {
          questions: [
            { sourceImage: "page-01.webp", type: "mcq" },
            { sourceImage: null, type: "essay" },
            { nested: { deeper: [{ sourceImage: "page-03.webp" }] } },
          ],
        },
      ],
    };
    expect(collectQuizSourceImages(quiz).sort()).toEqual(["page-01.webp", "page-03.webp"]);
    expect([...referencedFiles(lessons, [])].sort()).toEqual(["page-01.webp", "page-02.webp"]);
  });
});
