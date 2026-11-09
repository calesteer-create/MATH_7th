import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { BASE_PATH } from "./src/lib/base-path";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Two build modes from one unchanged codebase:
 *
 *   npm run build          → full server build (API, admin, media, middleware)
 *   npm run build:static   → GitHub Pages static export served at /MATH_7th/
 *
 * Route files that require a running server (API handlers, the admin tree, the
 * media pipeline, the locale middleware) carry a `.srv.tsx` / `.srv.ts`
 * suffix. `pageExtensions` below decides which suffixes count as routes: the
 * server build sees both plain and `.srv` files, the export build sees only
 * plain ones. Nothing is deleted — the exported site simply never compiles
 * code that cannot run on a static host.
 */
const isStaticExport = process.env.NEXT_OUTPUT === "export";

/** `srv.tsx`/`srv.ts` only match files literally named `page.srv.tsx` etc. */
const SERVER_ROUTE_EXTENSIONS = ["tsx", "ts", "srv.tsx", "srv.ts"];

const nextConfig: NextConfig = {
  ...(isStaticExport
    ? {
        output: "export" as const,
        // GitHub Pages serves this project under /MATH_7th/ — every route,
        // script, stylesheet and RSC payload must live below that prefix
        // (src/lib/base-path.ts is the single source of truth).
        basePath: BASE_PATH,
        assetPrefix: BASE_PATH,
        // Directory URLs (…/units/) resolve on any static host without
        // relying on extensionless-file mapping.
        trailingSlash: true,
        // There is no image optimizer on GitHub Pages.
        images: { unoptimized: true },
        pageExtensions: ["tsx", "ts"],
        // Inlined into the export bundle as a build-time marker so
        // `renderPerRequest()` can prerender pages exactly once (see
        // src/lib/render-mode.ts).
        env: { NEXT_STATIC_EXPORT: "1" },
        // Note: a custom distDir would become the export destination in this
        // mode (Next 16), so the export keeps writing to the standard out/.
      }
    : {
        pageExtensions: SERVER_ROUTE_EXTENSIONS,
      }),
  // Native modules must not be bundled by the server build.
  serverExternalPackages: ["better-sqlite3", "sharp"],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Large textbook page scans are uploaded in batches.
    serverActions: { bodySizeLimit: "60mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Robots-Tag", value: "noimageindex" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
