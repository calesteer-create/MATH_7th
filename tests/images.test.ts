import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { detectMime, storeLessonImage } from "@/lib/images";
import { mediaRoot, readKey } from "@/lib/storage";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "math7-img-"));
  process.env.UPLOAD_DIR = tmp;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A neutral technical test image: a grid pattern. No curriculum content.
async function makeJpeg(width = 1600, height = 2200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f5f5f0"/>
    <g stroke="#999" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 180}" x2="${width}" y2="${i * 180}"/>`).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

describe("upload sniffing", () => {
  it("detects formats from bytes, not filenames", async () => {
    const jpg = await makeJpeg(200, 200);
    expect(detectMime(jpg)).toBe("image/jpeg");
    expect(detectMime(await sharp(jpg).png().toBuffer())).toBe("image/png");
    expect(detectMime(await sharp(jpg).webp().toBuffer())).toBe("image/webp");
    expect(detectMime(Buffer.from("not an image at all"))).toBeNull();
  });
});

describe("lesson image storage", () => {
  it("stores an archival original plus web and thumbnail renditions", async () => {
    const jpeg = await makeJpeg();
    const stored = await storeLessonImage(jpeg, 42);

    expect(stored.storageKey).toMatch(/^lessons\/42\/original\//);
    expect(stored.webKey).toMatch(/^lessons\/42\/web\/.*\.webp$/);
    expect(stored.thumbKey).toMatch(/^lessons\/42\/thumb\/.*\.webp$/);
    expect(stored.mime).toBe("image/jpeg");
    expect(stored.sha256).toHaveLength(64);

    // Inside the media root, and readable back.
    expect(mediaRoot()).toBe(path.resolve(tmp));
    const original = await readKey(stored.storageKey);
    expect(original?.byteLength).toBe(jpeg.byteLength);

    const webMeta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(webMeta.format).toBe("webp");
    expect(webMeta.width).toBeLessThanOrEqual(2200);

    const thumbMeta = await sharp((await readKey(stored.thumbKey))!).metadata();
    expect(thumbMeta.width).toBeLessThanOrEqual(480);
  });

  it("downscales an oversized page but keeps aspect ratio", async () => {
    const stored = await storeLessonImage(await makeJpeg(4000, 5000), 7);
    const meta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(meta.width).toBeLessThanOrEqual(2200);
    expect(Math.abs((meta.width! / meta.height!) - 4000 / 5000)).toBeLessThan(0.01);
  });

  it("rejects a non-image upload", async () => {
    await expect(storeLessonImage(Buffer.from("<html>nope</html>"), 1)).rejects.toThrow(
      "unsupported_format",
    );
  });

  it("strips EXIF so a page scan cannot leak GPS coordinates", async () => {
    const withExif = await sharp(await makeJpeg(400, 400))
      .withExif({ IFD0: { ImageDescription: "geo-tagged" } })
      .jpeg()
      .toBuffer();
    const stored = await storeLessonImage(withExif, 99);
    const meta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(meta.exif).toBeUndefined();
  });
});

/**
 * The upload directory is written by the admin server, not only by the media
 * CLI, so it needs the same rule: a symlink planted inside it must not redirect
 * a write or a delete outside the root.
 */
describe("upload storage refuses symlink escapes", () => {
  let base: string;
  let uploadRoot: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-store-symlink-"));
    uploadRoot = path.join(base, "uploads");
    outside = path.join(base, "outside");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "ORIGINAL-BYTES");
    fs.symlinkSync(outside, path.join(uploadRoot, "images"));
    process.env.UPLOAD_DIR = uploadRoot;
  });

  afterAll(() => {
    process.env.UPLOAD_DIR = tmp;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked directory", async () => {
    const { writeKey } = await import("@/lib/storage");
    await expect(writeKey("images/evil.bin", Buffer.from("PAYLOAD"))).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("refuses to delete through a symlinked directory", async () => {
    const { resolveKey } = await import("@/lib/storage");
    expect(() => resolveKey("images/keep.txt")).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("still stores and reads a legitimate key", async () => {
    const { writeKey, readKey } = await import("@/lib/storage");
    await writeKey("real/ok.bin", Buffer.from("OK"));
    expect((await readKey("real/ok.bin"))?.toString("utf8")).toBe("OK");
  });
});

/**
 * Point 5 of the review: the root policy used to be documented one way and
 * implemented the other. The root is chosen by the operator, so it may itself
 * be a symlink (macOS `/tmp` is); everything below it may not.
 */
describe("root symlink policy", () => {
  let base: string;
  let real: string;
  let link: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-rootpolicy-"));
    real = path.join(base, "real");
    link = path.join(base, "link");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("accepts a root that is itself a symlink", async () => {
    const { resolveInside } = await import("@/media/tree");
    // Targets are expressed in the root's own namespace, which is what every
    // caller does (`path.join(root, …)`).
    expect(() => resolveInside(link, path.join(link, "lessons", "1.json"))).not.toThrow();
  });

  it("refuses a target expressed through the real path of a symlinked root", async () => {
    const { resolveInside } = await import("@/media/tree");
    // Two names for the same directory: accepting a mix would mean the caller
    // and the guard disagree about which string is the boundary.
    expect(() => resolveInside(link, path.join(real, "lessons", "1.json"))).toThrow(/outside/);
  });

  it("still refuses a symlink below the root", async () => {
    const { resolveInside } = await import("@/media/tree");
    const escape = path.join(base, "escape");
    fs.mkdirSync(escape, { recursive: true });
    fs.symlinkSync(escape, path.join(real, "linked"));
    expect(() => resolveInside(link, path.join(link, "linked", "x.json"))).toThrow(/symbolic link/);
  });

  it("refuses a target outside the root even when the root is a symlink", async () => {
    const { resolveInside } = await import("@/media/tree");
    expect(() => resolveInside(link, path.join(base, "elsewhere.json"))).toThrow(/outside/);
  });
});
