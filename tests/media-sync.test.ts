/**
 * `npm run media:sync` against a real (temporary) content tree.
 *
 * The scenario is the one the CMS creates: a WebP was uploaded through the
 * browser, so the lesson JSON references it but the derived fields (sha256,
 * width, height, thumb) are missing or wrong and no thumbnail exists. The sync
 * must repair the record, create the thumbnail, keep the tree valid, and report
 * (never delete) orphans.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateContentTree } from "@/content/validate";

let root = "";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const NOW = "2026-11-01T10:00:00.000Z";

function unit(id: number, position: number) {
  return {
    id,
    position,
    titleAr: `وحدة اختبار ${id}`,
    titleEn: `Test unit ${id}`,
    descriptionAr: "",
    descriptionEn: "",
    pageFrom: "",
    pageTo: "",
    accent: "teal",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function lesson(id: number, unitId: number, images: unknown[]) {
  return {
    id,
    unitId,
    position: 1,
    titleAr: `درس اختبار ${id}`,
    titleEn: "",
    pageLabel: "",
    status: "draft",
    isLastInUnit: true,
    publishedAt: null,
    contentUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    images,
  };
}

async function webp(width = 900, height = 1200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f0f0ea"/></svg>`;
  return sharp(Buffer.from(svg)).webp().toBuffer();
}

function runSync(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/media-sync.ts",
      "--content",
      path.join(root, "content"),
      "--media",
      path.join(root, "public", "media"),
      ...args,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "math7-sync-"));
  writeJson(path.join(root, "content", "units", "1.json"), unit(1, 1));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedCmsUploadedImage(lessonId: number): Promise<Buffer> {
  const dir = path.join(root, "public", "media", "lessons", String(lessonId));
  fs.mkdirSync(dir, { recursive: true });
  const buffer = await webp(900, 1200);
  fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
  // What the CMS produces: the file reference, but no derived fields.
  writeJson(
    path.join(root, "content", "lessons", `${lessonId}.json`),
    lesson(lessonId, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
  );
  return buffer;
}

describe("media:sync repairs a CMS-uploaded image", () => {
  it("fills sha256/width/height and creates the missing thumbnail", async () => {
    const buffer = await seedCmsUploadedImage(1);

    // Before: the tree is invalid (thumb mismatch, bad sha256, no thumbnail).
    const before = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(before.errors.length).toBeGreaterThan(0);

    const result = runSync();
    expect(result.stderr).not.toMatch(/✗/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thumbnails created: 1");

    const updated = JSON.parse(
      fs.readFileSync(path.join(root, "content", "lessons", "1.json"), "utf8"),
    ) as { images: Array<Record<string, unknown>> };
    const image = updated.images[0]!;
    expect(image["thumb"]).toBe("thumbs/page-01.webp");
    expect(image["width"]).toBe(900);
    expect(image["height"]).toBe(1200);
    expect(typeof image["sha256"]).toBe("string");
    expect((image["sha256"] as string)).toHaveLength(64);
    // The thumbnail exists and is a real, smaller WebP.
    const thumbPath = path.join(root, "public", "media", "lessons", "1", "thumbs", "page-01.webp");
    expect(fs.existsSync(thumbPath)).toBe(true);
    const thumbMeta = await sharp(fs.readFileSync(thumbPath)).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(thumbMeta.width).toBeLessThan(900);
    // The web file itself is untouched.
    expect(fs.readFileSync(path.join(root, "public", "media", "lessons", "1", "page-01.webp"))).toEqual(buffer);

    const after = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(after.errors).toEqual([]);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await seedCmsUploadedImage(2);
    expect(runSync().status).toBe(0);
    const first = fs.readFileSync(path.join(root, "content", "lessons", "2.json"), "utf8");
    const second = runSync();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("thumbnails created: 0");
    expect(second.stdout).toContain("image records refreshed: 0");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "2.json"), "utf8")).toBe(first);
  });

  it("--check fails when the tree is out of sync and succeeds afterwards", async () => {
    await seedCmsUploadedImage(3);
    const dirty = runSync("--check");
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/out of sync/);
    // --check must not have written anything.
    expect(
      fs.existsSync(path.join(root, "public", "media", "lessons", "3", "thumbs")),
    ).toBe(false);

    expect(runSync().status).toBe(0);
    expect(runSync("--check").status).toBe(0);
  });

  it("--dry-run reports work without writing", async () => {
    await seedCmsUploadedImage(4);
    const before = fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8");
    const result = runSync("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thumbnails created: 1");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "4", "thumbs"))).toBe(false);
  });

  it("reports an orphan file and never deletes it", async () => {
    await seedCmsUploadedImage(5);
    const orphan = path.join(root, "public", "media", "lessons", "5", "page-99.webp");
    fs.writeFileSync(orphan, await webp(300, 400));
    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("orphan lessons/5/page-99.webp");
    expect(result.stdout).toMatch(/not deleted/);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("fails loudly when a lesson references a missing file, and deletes nothing", async () => {
    fs.mkdirSync(path.join(root, "public", "media", "lessons", "6"), { recursive: true });
    writeJson(
      path.join(root, "content", "lessons", "6.json"),
      lesson(6, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
    );
    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing file referenced by a lesson/);
  });

  it("rejects a lesson record pointing at a non-WebP file", async () => {
    const dir = path.join(root, "public", "media", "lessons", "7");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page-01.webp"), Buffer.from("not really webp"));
    writeJson(
      path.join(root, "content", "lessons", "7.json"),
      lesson(7, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
    );
    const result = runSync();
    expect(result.stderr).toMatch(/not a WebP file/);
  });
});

describe("media:import end to end", () => {
  it("imports a folder of originals, records them, and leaves the originals alone", async () => {
    const sourceDir = path.join(root, "scans");
    fs.mkdirSync(sourceDir, { recursive: true });
    // Three neutral test pages.
    for (const [index, size] of [[1, 800], [2, 900], [3, 1000]] as const) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size + 200}">
        <rect width="100%" height="100%" fill="#fff"/><text x="20" y="60">page ${index}</text></svg>`;
      fs.writeFileSync(
        path.join(sourceDir, `scan-${index}.jpg`),
        await sharp(Buffer.from(svg)).jpeg().toBuffer(),
      );
    }
    writeJson(path.join(root, "content", "lessons", "8.json"), lesson(8, 1, []));

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/media-import.ts",
        "--lesson",
        "8",
        "--from",
        sourceDir,
        "--content",
        path.join(root, "content"),
        "--media",
        path.join(root, "public", "media"),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr).not.toMatch(/✗/);
    expect(result.status).toBe(0);

    const record = JSON.parse(
      fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8"),
    ) as { images: Array<{ file: string; position: number; sha256: string }> };
    expect(record.images.map((image) => image.file)).toEqual([
      "scan-1.webp",
      "scan-2.webp",
      "scan-3.webp",
    ]);
    expect(record.images.map((image) => image.position)).toEqual([1, 2, 3]);
    // Originals still exist in the source folder, untouched.
    expect(fs.readdirSync(sourceDir).sort()).toEqual(["scan-1.jpg", "scan-2.jpg", "scan-3.jpg"]);
    // Only WebP renditions were written into the repository tree.
    const mediaFiles = fs.readdirSync(path.join(root, "public", "media", "lessons", "8"), {
      recursive: true,
    }) as string[];
    expect(mediaFiles.filter((name) => /\.(jpe?g|png)$/i.test(name))).toEqual([]);
  });
});

/**
 * The value Sveltia actually writes (NEW-1).
 *
 * The CMS stores the asset's public path (`/media/lessons/<id>/<file>`) because
 * `getAssetPublicPath()` always prefixes `public_folder`; the content model
 * wants a bare name. `media:sync` canonicalises it — and this suite proves the
 * whole chain, from the config the CMS is served down to the strict validator.
 */
describe("media:sync canonicalises CMS-written paths", () => {
  /** Seeds a lesson whose record holds `stored` instead of a bare name. */
  async function seedWithStoredPath(lessonId: number, stored: string): Promise<Buffer> {
    const dir = path.join(root, "public", "media", "lessons", String(lessonId));
    fs.mkdirSync(dir, { recursive: true });
    const buffer = await webp(900, 1200);
    fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
    writeJson(
      path.join(root, "content", "lessons", `${lessonId}.json`),
      lesson(lessonId, 1, [{ position: 1, file: stored, width: null, height: null }]),
    );
    return buffer;
  }

  function readLesson(lessonId: number): { images: Array<Record<string, unknown>> } {
    return JSON.parse(fs.readFileSync(path.join(root, "content", "lessons", `${lessonId}.json`), "utf8"));
  }

  it("starts from the exact value the generated config implies", async () => {
    // The public_folder in public/admin/config.yml, with {{slug}} = lesson id.
    const config = fs.readFileSync(path.join(process.cwd(), "public/admin/config.yml"), "utf8");
    const publicFolder = /public_folder: "(\/media\/lessons\/\{\{slug\}\})"/.exec(config)?.[1];
    expect(publicFolder).toBe("/media/lessons/{{slug}}");
    const stored = `${publicFolder!.replace("{{slug}}", "2")}/page-01.webp`;
    expect(stored).toBe("/media/lessons/2/page-01.webp");

    await seedWithStoredPath(2, stored);

    // Before: the strict validator rejects it, because the model wants a bare name.
    const before = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(before.errors.some((issue) => issue.code === "IMAGE_FILE_INVALID")).toBe(true);
    expect(readLesson(2).images[0]!["file"]).toBe(stored);

    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("/media/lessons/2/page-01.webp");
    expect(result.stdout).toContain('"page-01.webp"');

    const after = readLesson(2);
    expect(after.images[0]!["file"]).toBe("page-01.webp");
    expect(after.images[0]!["thumb"]).toBe("thumbs/page-01.webp");
    expect(after.images[0]!["sha256"]).toMatch(/^[a-f0-9]{64}$/);

    const validated = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(validated.errors).toEqual([]);
  }, 120_000);

  it("shows every value it would rewrite under --dry-run and writes nothing", async () => {
    await seedWithStoredPath(3, "/media/lessons/3/page-01.webp");

    const result = runSync("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("canonicalise lesson 3");
    expect(result.stdout).toContain("dry run complete (nothing written)");

    // JSON untouched, and no thumbnail created either.
    expect(readLesson(3).images[0]!["file"]).toBe("/media/lessons/3/page-01.webp");
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "3", "thumbs"))).toBe(false);
  }, 120_000);

  it("is idempotent: a canonicalised record is not rewritten again", async () => {
    await seedWithStoredPath(4, "/media/lessons/4/page-01.webp");
    expect(runSync().status).toBe(0);
    const once = fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8");

    const second = runSync();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("canonicalise lesson 4");
    expect(second.stdout).toContain("image records refreshed: 0");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8")).toBe(once);
  }, 120_000);

  it("refuses a path for another lesson instead of guessing", async () => {
    // Lesson 5 points at lesson 9's folder: it must not be "repaired" to 5.
    await seedWithStoredPath(5, "/media/lessons/9/page-01.webp");

    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognised image path");
    expect(readLesson(5).images[0]!["file"]).toBe("/media/lessons/9/page-01.webp");
  }, 120_000);

  it("refuses traversal and hostile shapes, and leaves them untouched", async () => {
    for (const hostile of ["../6/page-01.webp", "/media/lessons/6/../../7/page-01.webp", "%2e%2e%2fpage-01.webp"]) {
      const dir = path.join(root, "public", "media", "lessons", "6");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "page-01.webp"), await webp());
      writeJson(
        path.join(root, "content", "lessons", "6.json"),
        lesson(6, 1, [{ position: 1, file: hostile, width: null, height: null }]),
      );
      const result = runSync();
      expect(result.status, hostile).toBe(1);
      expect(result.stderr, hostile).toContain("unrecognised image path");
      expect(readLesson(6).images[0]!["file"], hostile).toBe(hostile);
    }
  }, 180_000);

  it("refuses a non-WebP extension and asks for a re-upload (no renaming)", async () => {
    // A JPEG uploaded through the CMS: the bytes are JPEG even if the name lies.
    const dir = path.join(root, "public", "media", "lessons", "7");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page-01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
    writeJson(
      path.join(root, "content", "lessons", "7.json"),
      lesson(7, 1, [{ position: 1, file: "/media/lessons/7/page-01.jpg", width: null, height: null }]),
    );

    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognised image path");
    // Not renamed into .webp, and the .jpg file is still there.
    expect(readLesson(7).images[0]!["file"]).toBe("/media/lessons/7/page-01.jpg");
    expect(fs.existsSync(path.join(dir, "page-01.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "page-01.webp"))).toBe(false);
  }, 120_000);

  it("writes no JSON at all when one lesson fails (no half-edited tree)", async () => {
    // Lesson 8 is fine and would be canonicalised; lesson 9 is unfixable.
    await seedWithStoredPath(8, "/media/lessons/8/page-01.webp");
    const dir9 = path.join(root, "public", "media", "lessons", "9");
    fs.mkdirSync(dir9, { recursive: true });
    fs.writeFileSync(path.join(dir9, "page-01.webp"), await webp());
    writeJson(
      path.join(root, "content", "lessons", "9.json"),
      lesson(9, 1, [{ position: 1, file: "/media/lessons/42/page-01.webp", width: null, height: null }]),
    );
    const before8 = fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8");
    const before9 = fs.readFileSync(path.join(root, "content", "lessons", "9.json"), "utf8");

    const result = runSync();
    expect(result.status).toBe(1);
    // The successful lesson is reported (so --dry-run parity holds)…
    expect(result.stdout).toContain("/media/lessons/8/page-01.webp");
    // …but nothing was written, for either lesson.
    expect(fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8")).toBe(before8);
    expect(fs.readFileSync(path.join(root, "content", "lessons", "9.json"), "utf8")).toBe(before9);
  }, 120_000);

  it("never renames, moves or deletes a source file while canonicalising", async () => {
    const dir = path.join(root, "public", "media", "lessons", "10");
    fs.mkdirSync(dir, { recursive: true });
    const buffer = await webp(900, 1200);
    fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
    writeJson(
      path.join(root, "content", "lessons", "10.json"),
      lesson(10, 1, [{ position: 1, file: "/media/lessons/10/page-01.webp", width: null, height: null }]),
    );
    const listBefore = fs.readdirSync(dir).sort();

    expect(runSync().status).toBe(0);

    const listAfter = fs.readdirSync(dir).sort();
    // The original page is byte-identical; only thumbs/ was added.
    expect(listAfter.filter((name) => name !== "thumbs")).toEqual(listBefore);
    expect(fs.readFileSync(path.join(dir, "page-01.webp")).equals(buffer)).toBe(true);
  }, 120_000);
});
