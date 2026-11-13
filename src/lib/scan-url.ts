/**
 * scanUrl — where a lesson page scan is served.
 *
 * Server build:  /media/i/<imageId>/<variant>
 *                The route (src/app/media/i/[imageId]/[variant]/route.srv.ts)
 *                authorises every request: a published lesson is public, a
 *                draft is owner-only, and the bytes are streamed from the
 *                upload store. Nothing is copied or exposed statically.
 *
 * Static export: /MATH_7th/media/lessons/<lessonId>/<file>[thumbs/<file>]
 *                GitHub Pages has no server route, so the export publishes the
 *                WebP files themselves (scripts/build-static.mjs copies exactly
 *                the published, referenced ones via scripts/static-media.mjs).
 *
 * Both hosts therefore show the same image, and the difference lives here
 * instead of being repeated at every call site.
 *
 * Export mode THROWS when the content tree has no filename: falling back to the
 * server route would ship a URL that 404s on Pages, and such a lesson should
 * have been rejected by `npm run content:validate` long before build time.
 */
import { BASE_PATH, isStaticExport } from "@/lib/base-path";

export type ScanVariant = "web" | "thumb";

export interface ScanUrlInput {
  /** Server-mode identity of the upload row. */
  legacyImageId: number;
  /** Bare filename from the content tree; required in export mode. */
  file?: string;
  /** Owning lesson, needed to build the published path. */
  lessonId: number;
  variant: ScanVariant;
}

export function scanUrl({ legacyImageId, file, lessonId, variant }: ScanUrlInput): string {
  if (!isStaticExport()) {
    return `/media/i/${legacyImageId}/${variant}`;
  }
  if (!file) {
    throw new Error(
      `scanUrl — lesson ${lessonId} has an image without a file name; ` +
        "a static export cannot serve it (see docs/CONTENT_MODEL.md §8.1)",
    );
  }
  const folder = variant === "thumb" ? `thumbs/` : "";
  return `${BASE_PATH}/media/lessons/${lessonId}/${folder}${file}`;
}
