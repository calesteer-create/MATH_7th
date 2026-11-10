/**
 * Image format rules for the local import pipeline (PR 5).
 *
 * The server-side upload path (src/lib/images.ts) and the local import path
 * must agree byte-for-byte on what is acceptable, so the primitives live here
 * and src/lib/images.ts re-exports them. Nothing in this module touches the
 * filesystem or sharp: it is pure input validation, which is what makes it
 * cheap to test exhaustively.
 */

export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

/** Textbook pages are dense; 2200px on the long edge stays legible when zoomed. */
export const WEB_MAX_EDGE = 2200;
export const THUMB_MAX_EDGE = 480;
export const WEBP_QUALITY = 84;
export const THUMB_QUALITY = 70;

/** Default ceiling for one source file (15 MiB), same as MAX_UPLOAD_BYTES. */
export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Dimension bounds enforced before any encoding happens.
 *
 * The lower bound rejects thumbnails/avatars pasted by mistake and the upper
 * bound stops a decompression bomb from being decoded at all: sharp would
 * happily allocate gigabytes for a 60 000 x 60 000 PNG.
 */
export const MIN_IMAGE_EDGE = 64;
export const MAX_IMAGE_EDGE = 20_000;
export const MAX_IMAGE_PIXELS = 120_000_000;

export type MimeRejection = "unsupported_format";

/**
 * Sniffs the container format from the bytes, never from the filename or the
 * client-supplied MIME type: an `.jpg` that is really a PDF must be rejected.
 */
export function detectMime(buffer: Buffer): AcceptedMime | null {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") {
    return "image/png";
  }
  if (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** True when a stored file really is WebP (used by the content validator). */
export function isWebpMagic(buffer: Buffer): boolean {
  return detectMime(buffer) === "image/webp";
}

export interface DimensionProblem {
  code: "IMAGE_TOO_SMALL" | "IMAGE_TOO_LARGE";
  message: string;
}

export function checkDimensions(
  width: number | undefined,
  height: number | undefined,
): DimensionProblem | null {
  if (!width || !height) {
    return { code: "IMAGE_TOO_SMALL", message: "image has no readable pixel dimensions" };
  }
  if (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE) {
    return {
      code: "IMAGE_TOO_SMALL",
      message: `image is ${width}x${height}; both edges must be at least ${MIN_IMAGE_EDGE}px`,
    };
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    return {
      code: "IMAGE_TOO_LARGE",
      message: `image is ${width}x${height}; neither edge may exceed ${MAX_IMAGE_EDGE}px`,
    };
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    return {
      code: "IMAGE_TOO_LARGE",
      message: `image is ${width}x${height} (${width * height} pixels); the limit is ${MAX_IMAGE_PIXELS}`,
    };
  }
  return null;
}

/** Human-readable byte count for CLI output (no Intl — guard rule). */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KiB`;
  return `${Math.round(bytes / 104857.6) / 10} MiB`;
}
