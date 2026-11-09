#!/usr/bin/env node
/**
 * Serves the static export the way GitHub Pages serves
 * https://calesteer-create.github.io/MATH_7th/:
 *
 *   - everything lives under the /MATH_7th/ prefix;
 *   - "/path/" resolves to path/index.html (trailing-slash URLs);
 *   - extensionless URLs try /index.html then .html;
 *   - unknown paths answer 404 with out/404.html;
 *   - queries are ignored for file lookup (GitHub Pages does the same, which
 *     is why the client router requests .txt RSC payloads in export mode).
 *
 *   npm run preview:static              # http://localhost:4173/MATH_7th/
 *   npm run preview:static -- --port 0  # pick a free port, printed as PORT=<n>
 *
 * The static-export tests spawn this script, so its URL behaviour is the
 * behaviour that gets verified.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const BASE_PATH = "/MATH_7th";
const OUT_DIR = path.join(process.cwd(), "out");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1] !== undefined) return Number(argv[i + 1]);
  return 4173;
}

/** Resolve a request path (already stripped of query) to a file in out/. */
function resolveFile(pathname) {
  if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return null;
  let rel = pathname.slice(BASE_PATH.length) || "/";
  if (rel === "/") rel = "/index.html";
  const normalized = path.posix.normalize(rel);
  if (normalized.includes("..")) return null; // no traversal outside out/
  const abs = path.join(OUT_DIR, normalized);
  if (!abs.startsWith(OUT_DIR)) return null;

  const tryFiles = [];
  if (normalized.endsWith("/")) tryFiles.push(path.join(abs, "index.html"));
  else {
    tryFiles.push(abs);
    if (!path.extname(abs)) {
      tryFiles.push(`${abs}.html`, path.join(abs, "index.html"));
    }
  }
  for (const file of tryFiles) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function send(res, status, file, extraHeaders = {}) {
  const ext = path.extname(file).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  fs.createReadStream(file).pipe(res);
}

function redirect(res, location) {
  res.writeHead(301, { Location: location, "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Redirecting to ${location}\n`);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    // Bare project root → GitHub Pages redirects to the trailing slash.
    if (pathname === BASE_PATH) return redirect(res, `${BASE_PATH}/`);

    // Directory (or extensionless path resolving to one) without a trailing
    // slash → the same 301 GitHub Pages issues. Checked before resolveFile,
    // which would otherwise serve the index with a 200.
    if (!pathname.endsWith("/") && !path.extname(pathname)) {
      const dirIndex = resolveFile(`${pathname}/`);
      if (dirIndex) return redirect(res, `${pathname}/`);
    }

    const file = resolveFile(pathname);
    if (file) return send(res, 200, file);

    // Unknown path → GitHub Pages serves 404.html with status 404.
    const notFound = path.join(OUT_DIR, "404.html");
    if (fs.existsSync(notFound)) return send(res, 404, notFound);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 — not found\n");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`500 — ${err instanceof Error ? err.message : "error"}\n`);
  }
});

if (!fs.existsSync(OUT_DIR)) {
  console.error("✗ preview:static — out/ does not exist. Run `npm run build:static` first.");
  process.exit(1);
}

const port = parsePort(process.argv.slice(2));
server.listen(port, "0.0.0.0", () => {
  const actual = server.address().port;
  // PORT=<n> is parsed by tests/static-export.test.ts — keep the format.
  console.log(`static-preview PORT=${actual}`);
  console.log(`✓ preview: http://localhost:${actual}${BASE_PATH}/`);
});
