#!/usr/bin/env node
/**
 * GitHub Pages artifact preparation and audit.
 *
 *   node scripts/pages-artifact.mjs prepare   # out/ -> pages-dist/
 *   node scripts/pages-artifact.mjs audit     # audit pages-dist/
 *
 * This is a fail-closed boundary between the Next static export and the thing
 * that is actually uploaded to GitHub Pages. `out/` is not trusted merely
 * because the build succeeded: the raw export still copies `public/admin/`,
 * and a future build mistake could add another server-only or sensitive file.
 *
 * Policy:
 *   - only the public static site trees are copied;
 *   - `admin/` is deliberately excluded (Sveltia is not published in this phase);
 *   - API routes, server media routes, databases, env files and source files fail;
 *   - symlinks and non-regular files fail;
 *   - the only approved hidden file is the root `.nojekyll`;
 *   - text assets are scanned for private-repo markers, draft sentinels, token
 *     shapes, keys and references to server-only routes;
 *   - root-absolute HTML/CSS references must stay under `/MATH_7th/`.
 *
 * The script intentionally has no network access and reads no credentials.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_DIR = path.join(ROOT, "out");
const DEST_DIR = path.join(ROOT, "pages-dist");
const BASE_PATH = "/MATH_7th";

/** Root entries produced by the public Next static export. */
const ALLOWED_ROOT_DIRS = new Set(["_next", "_not-found", "404", "ar", "en"]);
const ALLOWED_ROOT_FILES = new Set(["index.html", "404.html", ".nojekyll"]);

/** Static web assets only. Source maps, databases, configs and source files fail. */
const ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".txt",
  ".js",
  ".css",
  ".woff",
  ".woff2",
  ".ttf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".ico",
]);

const TEXT_EXTENSIONS = new Set([".html", ".txt", ".js", ".css", ".svg"]);

/** Paths that must never appear in the published artifact. */
const FORBIDDEN_SEGMENTS = new Set([
  "admin",
  "api",
  "data",
  "node_modules",
  "content",
  "src",
  ".git",
  ".github",
  ".next",
]);

const SENSITIVE_BASENAME =
  /(^|[-_.])(secret|secrets|credential|credentials|password|passwords|private|token|tokens)([-_.]|$)/i;

const CONTENT_PATTERNS = [
  {
    name: "private editorial repository marker",
    re: /calesteer-create\/MATH_7th-drafts/i,
  },
  {
    name: "draft content sentinel",
    re: /DRAFT-SECRET-MUST-NOT-APPEAR/,
  },
  {
    name: "server-only route reference",
    re: /["'(]\/MATH_7th\/(?:admin|api|media\/i)(?:\/|["')])/,
  },
  {
    name: "GitHub token shape",
    re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  },
  {
    name: "private key block",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: "secret assignment",
    re: /\b(?:ADMIN_SESSION_SECRET|ADMIN_PASSWORD|QUIZ_API_KEY)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{8,}/,
  },
];

/** GitHub Pages published-site limit is 1 GB; stay below it. */
const MAX_TOTAL_BYTES = 1_000_000_000;
/** Bound text scanning memory; the current export's text assets are far smaller. */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

function fail(message) {
  console.error(`✗ pages-artifact — ${message}`);
  process.exit(1);
}

function isHidden(rel) {
  return rel.split("/").some((segment) => segment.startsWith("."));
}

function isNoJekyll(rel) {
  return rel === ".nojekyll";
}

function hasForbiddenSegment(rel) {
  const parts = rel.split("/").map((segment) => segment.toLowerCase());
  if (parts.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  // The server-only image route is `/media/i/<id>/<variant>`.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "media" && parts[i + 1] === "i") return true;
  }
  return false;
}

function hasSensitiveBasename(rel) {
  const base = path.posix.basename(rel);
  if (/^\.env(?:\.|$)/i.test(base)) return true;
  if (/\.(?:db|sqlite)(?:[-_]|$)/i.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|log)$/i.test(base)) return true;
  if (/^admin-verification\.json$/i.test(base)) return true;
  return SENSITIVE_BASENAME.test(base);
}

function isAllowedShape(rel, isDirectory) {
  if (isNoJekyll(rel)) return !isDirectory;
  if (isHidden(rel)) return false;
  if (hasForbiddenSegment(rel)) return false;
  if (hasSensitiveBasename(rel)) return false;

  const parts = rel.split("/");
  const root = parts[0];
  if (parts.length === 1) {
    return isDirectory ? ALLOWED_ROOT_DIRS.has(root) : ALLOWED_ROOT_FILES.has(root);
  }
  if (!ALLOWED_ROOT_DIRS.has(root)) return false;
  if (isDirectory) return true;
  return ALLOWED_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
}

function lstatOrThrow(abs, rel) {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink is not allowed: ${rel}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`non-regular file is not allowed: ${rel}`);
  }
  return stat;
}

function assertSafeRel(rel) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new Error(`unsafe relative path: ${rel}`);
  }
}

/** Walk a tree without following symlinks. */
function walk(dir, base = "", visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    assertSafeRel(rel);
    const abs = path.join(dir, entry.name);
    const stat = lstatOrThrow(abs, rel);
    if (stat.isDirectory()) {
      visit(rel, abs, true, stat);
      walk(abs, rel, visit);
    } else {
      visit(rel, abs, false, stat);
    }
  }
}

function assertPublicUrl(rel, url, attribute) {
  // External links and inline data are not artifact paths. Root-absolute
  // references, however, must include the GitHub Pages project prefix.
  if (/^(?:https?:|mailto:|tel:|data:|#)/i.test(url)) return;
  if (!url.startsWith("/")) return;
  if (!url.startsWith(`${BASE_PATH}/`)) {
    throw new Error(`root-absolute ${attribute} is outside ${BASE_PATH}/ in ${rel}`);
  }
  const route = url.slice(BASE_PATH.length).split(/[?#]/, 1)[0].toLowerCase();
  if (/^\/(?:admin|api|media\/i)(?:\/|$)/.test(route)) {
    throw new Error(`forbidden server-only ${attribute} in ${rel}`);
  }
}

function scanReferences(rel, text) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (ext === ".html") {
    for (const tag of text.matchAll(/<[a-z][^>]*>/gi)) {
      const element = tag[0];
      const isPreconnect = /rel=["']preconnect["']/i.test(element);
      for (const match of element.matchAll(/\b(href|src)=["']([^"']*)["']/gi)) {
        const attribute = match[1].toLowerCase();
        const url = match[2];
        // Next emits one origin-only preconnect hint; it is not a page link.
        if (attribute === "href" && url === "/" && isPreconnect) continue;
        assertPublicUrl(rel, url, attribute);
      }
      const refresh = /\bcontent=["']\d+\s*;\s*url=([^"']+)["']/i.exec(element);
      if (refresh) assertPublicUrl(rel, refresh[1], "meta refresh");
    }
  }
  if (ext === ".css" || ext === ".html" || ext === ".svg") {
    for (const match of text.matchAll(/url\(\s*["']?(\/[^)"']*)["']?\s*\)/gi)) {
      assertPublicUrl(rel, match[1], "CSS url");
    }
  }
}

function scanText(rel, abs, size) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return;
  if (size > MAX_TEXT_BYTES) {
    throw new Error(`text asset is too large to audit safely: ${rel}`);
  }
  const text = fs.readFileSync(abs, "utf8");
  for (const pattern of CONTENT_PATTERNS) {
    if (pattern.re.test(text)) {
      // Never print the matched value; it may be sensitive.
      throw new Error(`forbidden content (${pattern.name}) in ${rel}`);
    }
  }
  scanReferences(rel, text);
}

function auditDir(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`artifact root must be a real directory: ${dir}`);
  }

  const required = [".nojekyll", "index.html", "404.html", "ar/index.html", "en/index.html"];
  const files = [];
  let dirs = 0;
  let bytes = 0;

  walk(dir, "", (rel, abs, isDirectory, entryStat) => {
    if (!isAllowedShape(rel, isDirectory)) {
      throw new Error(`disallowed artifact entry: ${rel}`);
    }
    if (isDirectory) {
      dirs++;
      return;
    }
    files.push(rel);
    bytes += entryStat.size;
    // Check the size before reading text assets: a malformed or hostile export
    // must fail as "too large", not exhaust memory while scanning it.
    if (bytes > MAX_TOTAL_BYTES) {
      throw new Error(`artifact is too large for GitHub Pages: ${bytes} bytes`);
    }
    scanText(rel, abs, entryStat.size);
  });

  if (!files.some((rel) => rel.startsWith("_next/"))) {
    throw new Error("required artifact directory is missing or empty: _next/");
  }
  for (const rel of required) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) {
      throw new Error(`required artifact file is missing: ${rel}`);
    }
  }
  if (bytes > MAX_TOTAL_BYTES) {
    throw new Error(`artifact is too large for GitHub Pages: ${bytes} bytes`);
  }
  if (files.length === 0) {
    throw new Error("artifact is empty");
  }
  return { files: files.length, dirs, bytes };
}

function prepare() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error("out/ does not exist — run `npm run build:static` first");
  }
  const sourceStat = fs.lstatSync(SOURCE_DIR);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("out/ must be a real directory");
  }

  if (fs.existsSync(DEST_DIR)) {
    const destStat = fs.lstatSync(DEST_DIR);
    if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
      throw new Error("pages-dist/ exists but is not a real directory");
    }
    // Generated directory only; never follow a symlinked destination.
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DEST_DIR, { recursive: true });

  let copied = 0;
  let excludedAdmin = 0;

  function copyTree(srcDir, destDir, base = "") {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      assertSafeRel(rel);
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      const stat = lstatOrThrow(src, rel);

      // The experimental Sveltia panel lives in public/admin and is copied by
      // Next into out/admin. It is intentionally not published in this phase.
      if (rel === "admin" && stat.isDirectory()) {
        excludedAdmin++;
        continue;
      }

      if (!isAllowedShape(rel, stat.isDirectory())) {
        throw new Error(`disallowed export entry: ${rel}`);
      }

      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        copyTree(src, dest, rel);
      } else {
        fs.copyFileSync(src, dest);
        copied++;
      }
    }
  }

  copyTree(SOURCE_DIR, DEST_DIR);
  const summary = auditDir(DEST_DIR);
  console.log(`✓ pages-artifact prepare — ${copied} files copied, admin/ excluded (${excludedAdmin} root)`);
  console.log(`✓ pages-artifact audit   — ${summary.files} files, ${summary.dirs} dirs, ${summary.bytes} bytes`);
}

function main() {
  const command = process.argv[2];
  try {
    if (command === "prepare") {
      prepare();
      return;
    }
    if (command === "audit") {
      if (!fs.existsSync(DEST_DIR)) {
        throw new Error("pages-dist/ does not exist — run `npm run pages:prepare` first");
      }
      const summary = auditDir(DEST_DIR);
      console.log(`✓ pages-artifact audit — ${summary.files} files, ${summary.dirs} dirs, ${summary.bytes} bytes`);
      return;
    }
    throw new Error("usage: node scripts/pages-artifact.mjs <prepare|audit>");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
