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
