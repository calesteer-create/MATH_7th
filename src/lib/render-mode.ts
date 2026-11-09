import { unstable_noStore } from "next/cache";
import { isStaticExport } from "./base-path";

/**
 * Rendering mode for the public pages (home, units, lessons, quizzes).
 *
 * The GitHub Pages export (`npm run build:static`) must prerender every page
 * once at build time, so it must never hit a dynamic-API bailout. The server
 * build (`npm run build`) keeps today's behaviour instead: these pages render
 * per request, so owner edits through the admin panel are visible immediately
 * without depending on cache revalidation.
 *
 * The branch is decided by the build markers in src/lib/base-path.ts — never
 * by a segment config, because those must be static literals and cannot
 * differ per build mode.
 */
export function renderPerRequest(): void {
  if (isStaticExport()) return;
  unstable_noStore();
}
