/**
 * The import/encode step of the media pipeline (PR 5).
 *
 * One source photograph of a textbook page becomes exactly two committed
 * files, and nothing else:
 *
 *   public/media/lessons/<id>/<name>.webp         web rendition (≤2200px)
 *   public/media/lessons/<id>/thumbs/<name>.webp  thumbnail    (≤480px)
 *
 * The source file is *never* copied into the repository. That is the difference
 * between this pipeline and the server upload path in src/lib/images.ts, which
 * archives the original in data/uploads/ (git-ignored) because it serves a
 * live app. Requirement: "الصور الأصلية عالية الدقة تبقى على جهازي محليًا".
 *
 * Metadata: `.rotate()` is applied first so EXIF orientation is *baked into the
 * pixels*, then WebP is encoded with no EXIF/ICC/XMP block at all. sharp's WebP
 * encoder writes only an optional ICC profile, and we explicitly disable that
 * too — so a phone photo's GPS coordinates cannot survive the trip.
 */

import crypto from "node:crypto";
import sharp from "sharp";
import {
  DEFAULT_MAX_BYTES,
  THUMB_MAX_EDGE,
  THUMB_QUALITY,
  WEB_MAX_EDGE,
  WEBP_QUALITY,
  checkDimensions,
  detectMime,
} from "./format";

export interface ProcessedImage {
  /** WebP bytes of the page rendition. */
  web: Buffer;
  /** WebP bytes of the thumbnail. */
  thumb: Buffer;
  width: number;
  height: number;
  /** Size in bytes of the *source* file (informational, stored in the lesson). */
  sourceBytes: number;
  /** sha256 (lowercase hex) of `web` — the content-model integrity hash. */
  sha256: string;
  /** sha256 of the thumbnail, useful for cache-busting checks in tests. */
  thumbSha256: string;
}

export class MediaError extends Error {
  constructor(
    readonly code:
      | "UNSUPPORTED_FORMAT"
      | "FILE_TOO_LARGE"
      | "IMAGE_TOO_SMALL"
      | "IMAGE_TOO_LARGE"
      | "DECODE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export interface ProcessOptions {
  maxBytes?: number;
}

/**
 * Validates and normalises one source image. Throws MediaError with a stable
 * code; the CLI turns those into per-file rows and keeps going.
 */
export async function processSourceImage(
  source: Buffer,
  options: ProcessOptions = {},
): Promise<ProcessedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (source.byteLength === 0) throw new MediaError("UNSUPPORTED_FORMAT", "file is empty");
  if (source.byteLength > maxBytes) {
    throw new MediaError(
      "FILE_TOO_LARGE",
      `file is ${source.byteLength} bytes; the limit is ${maxBytes} bytes`,
    );
  }
  const mime = detectMime(source);
  if (!mime) {
    throw new MediaError(
      "UNSUPPORTED_FORMAT",
      "not a JPEG, PNG or WebP file (checked from the bytes, not the extension)",
    );
  }

  // limitInputPixels stops a decompression bomb before the full decode.
  const pipeline = sharp(source, { limitInputPixels: 120_000_000, failOn: "error" }).rotate();
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await pipeline.metadata();
  } catch (error) {
    throw new MediaError("DECODE_FAILED", `could not read the image: ${(error as Error).message}`);
  }
  const dimensionProblem = checkDimensions(
    metadata.autoOrient?.width ?? metadata.width,
    metadata.autoOrient?.height ?? metadata.height,
  );
  if (dimensionProblem) {
    throw new MediaError(
      dimensionProblem.code === "IMAGE_TOO_SMALL" ? "IMAGE_TOO_SMALL" : "IMAGE_TOO_LARGE",
      dimensionProblem.message,
    );
  }

  const encode = async (maxEdge: number, quality: number): Promise<Buffer> => {
    try {
      return await pipeline
        .clone()
        .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
        // No ICC profile, no EXIF, no XMP: the encoder emits a bare WebP.
        .webp({ quality, effort: 4, smartSubsample: true })
        .toBuffer();
    } catch (error) {
      throw new MediaError("DECODE_FAILED", `could not encode WebP: ${(error as Error).message}`);
    }
  };

  const web = await encode(WEB_MAX_EDGE, WEBP_QUALITY);
  const thumb = await encode(THUMB_MAX_EDGE, THUMB_QUALITY);

  if (detectMime(web) !== "image/webp") {
    throw new MediaError("DECODE_FAILED", "encoder produced something that is not WebP");
  }

  const webMeta = await sharp(web).metadata();
  return {
    web,
    thumb,
    width: webMeta.width ?? 0,
    height: webMeta.height ?? 0,
    sourceBytes: source.byteLength,
    sha256: sha256Hex(web),
    thumbSha256: sha256Hex(thumb),
  };
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Metadata an inspector can assert on: proves the strip actually happened. */
export async function inspectWebp(buffer: Buffer): Promise<{
  format: string | undefined;
  width: number | undefined;
  height: number | undefined;
  hasExif: boolean;
  hasIcc: boolean;
  hasXmp: boolean;
}> {
  const meta = await sharp(buffer).metadata();
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    hasExif: meta.exif !== undefined,
    hasIcc: meta.icc !== undefined,
    hasXmp: meta.xmp !== undefined,
  };
}
