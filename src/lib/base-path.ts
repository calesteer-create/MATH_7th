/**
 * Single source of truth for the GitHub Pages project path
 * (https://calesteer-create.github.io/MATH_7th/) and for detecting the
 * static-export build.
 *
 * - `next.config.ts` reads `BASE_PATH` when `output: "export"` is on.
 * - `generateMetadata` prefixes alternate-language links with it.
 * - `renderPerRequest()` and `generateStaticParams()` use `isStaticExport()`.
 *
 * Two independent markers exist on purpose: `NEXT_STATIC_EXPORT` is inlined
 * into the export bundle by `env` in next.config.ts (safe for module scope),
 * while `NEXT_OUTPUT` is the build-time environment variable set by
 * scripts/build-static.mjs (safe for code that only runs during the build,
 * such as generateStaticParams).
 */
export function isStaticExport(): boolean {
  return process.env.NEXT_STATIC_EXPORT === "1" || process.env.NEXT_OUTPUT === "export";
}

/** Empty string for the server build; "/MATH_7th" for the static export. */
export const BASE_PATH = isStaticExport() ? "/MATH_7th" : "";
