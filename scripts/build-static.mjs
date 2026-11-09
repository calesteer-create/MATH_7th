#!/usr/bin/env node
/**
 * Builds the GitHub Pages static export (PR 4).
 *
 *   npm run build:static
 *
 * Steps:
 *   1. Apply database migrations (idempotent) — the public pages read units
 *      and lessons at build time so they can be prerendered into HTML.
 *   2. `next build` with NEXT_OUTPUT=export: output "export", basePath and
 *      assetPrefix "/MATH_7th", server-only `.srv` route files excluded.
 *   3. Write out/index.html — the locale redirect that the next-intl
 *      middleware performs on the server can only be a static stub here.
 *
 * The result in out/ is served at /MATH_7th/ by GitHub Pages; preview the
 * exact same layout locally with `npm run preview:static`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "out");

function fail(message, code = 1) {
  console.error(`✗ build:static — ${message}`);
  process.exit(code);
}

// ── 1. Database schema (build-time content reads) ──────────────────────────
const migrate = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
  stdio: "inherit",
  env: process.env,
  cwd: root,
});
if (migrate.error) fail(`could not start migration: ${migrate.error.message}`);
if (migrate.status !== 0) fail("database migration failed", migrate.status ?? 1);

// ── 2. Static export build ─────────────────────────────────────────────────
// `next dev` leaves route typegen in .next/dev/types describing the SERVER
// route set (admin/api included). The export build generates a different
// route set (no .srv files) and its TypeScript check fails when it also
// reads those stale dev validators — drop them first.
const devTypes = path.join(root, ".next", "dev");
if (fs.existsSync(devTypes)) {
  fs.rmSync(devTypes, { recursive: true, force: true });
  console.log("✓ removed stale .next/dev (dev route types)");
}

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
if (!fs.existsSync(nextBin)) fail("next is not installed — run npm ci first");
const build = spawnSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_OUTPUT: "export" },
  cwd: root,
});
if (build.error) fail(`could not start next build: ${build.error.message}`);
if (build.status !== 0) fail("next build failed", build.status ?? 1);

// ── 3. Root redirect (static stand-in for the locale middleware) ───────────
// GitHub Pages serves /MATH_7th/ from out/index.html; there is no route at
// "/", so the export writes the same redirect the middleware issues on the
// server: default locale first (see src/i18n/routing.ts).
const basePath = "/MATH_7th";
const rootHtml = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${basePath}/ar/" />
    <link rel="canonical" href="${basePath}/ar/" />
    <title>MATH 7TH</title>
  </head>
  <body>
    <p><a href="${basePath}/ar/">MATH 7TH — رياضيات الصف السابع</a></p>
  </body>
</html>
`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "index.html"), rootHtml, "utf8");

// GitHub Pages runs Jekyll by default, which drops underscore-prefixed
// directories — without this file the _next/ assets would never publish.
fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");

function countHtml(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countHtml(path.join(dir, entry.name));
    else if (entry.name.endsWith(".html")) n += 1;
  }
  return n;
}
const htmlCount = countHtml(outDir);

console.log(`✓ build:static — ${htmlCount} HTML files in out/ (served at ${basePath}/)`);
console.log(`  preview: npm run preview:static  →  http://localhost:4173${basePath}/`);
