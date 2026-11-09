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
