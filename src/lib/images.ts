import sharp from "sharp";
import { newKey, sha256, writeKey } from "./storage";

export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 15 * 1024 * 1024);

/** Textbook pages are dense; 2200px on the long edge stays legible when zoomed. */
const WEB_MAX_EDGE = 2200;
const THUMB_MAX_EDGE = 480;

export interface StoredImage {
  storageKey: string;
  webKey: string;
  thumbKey: string;
  mime: AcceptedMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export function detectMime(buffer: Buffer): AcceptedMime | null {
  // Sniffed from the bytes, not trusted from the client-supplied filename.
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString("latin1") === "PNG"
  ) {
    return "image/png";
  }
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * Normalises an uploaded photograph of a textbook page.
 *
 * EXIF is dropped on purpose: phone photos routinely carry GPS coordinates, and
 * lesson scans must never leak where they were photographed. `.rotate()` with no
 * argument applies the EXIF orientation *before* the metadata is discarded, so
 * pages do not end up sideways.
 */
export async function storeLessonImage(buffer: Buffer, lessonId: number): Promise<StoredImage> {
  const mime = detectMime(buffer);
  if (!mime) throw new Error("unsupported_format");
  if (buffer.byteLength > MAX_UPLOAD_BYTES) throw new Error("too_large");

  const digest = sha256(buffer);
  const prefix = `lessons/${lessonId}`;

  // Original kept verbatim for archival quality.
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
  const storageKey = newKey(`${prefix}/original`, ext);
  await writeKey(storageKey, buffer);

  const normalized = sharp(buffer).rotate();
  const metadata = await normalized.metadata();

  const webBuffer = await normalized
    .clone()
    .resize({ width: WEB_MAX_EDGE, height: WEB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84 })
    .toBuffer();
  const webKey = newKey(`${prefix}/web`, "webp");
  await writeKey(webKey, webBuffer);

  const thumbBuffer = await normalized
    .clone()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
  const thumbKey = newKey(`${prefix}/thumb`, "webp");
  await writeKey(thumbKey, thumbBuffer);

  const webMeta = await sharp(webBuffer).metadata();

  return {
    storageKey,
    webKey,
    thumbKey,
    mime,
    width: webMeta.width ?? metadata.width ?? 0,
    height: webMeta.height ?? metadata.height ?? 0,
    bytes: buffer.byteLength,
    sha256: digest,
  };
}
