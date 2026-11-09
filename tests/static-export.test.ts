/**
 * Static export (GitHub Pages) verification for PR 4.
 *
 * Runs the real pipeline — `scripts/build-static.mjs` (migrate → next build
 * with output:"export" → root redirect → .nojekyll) — twice:
 *
 *   1. empty content  — the repository ships no curriculum; the export must
 *      still succeed, link cleanly, and expose no placeholder as real content;
 *   2. seeded content — one unit, one published lesson, one draft and one
 *      image row in a TEMP database (never the repo's data/) — proving that
 *      real pages export, drafts stay hidden, and every URL lives under
 *      /MATH_7th/.
 *
 * Then it serves out/ through scripts/preview-static.mjs — which mimics
 * GitHub Pages (trailing-slash directories, 404.html, .txt payloads) — and
 * crawls the site like a browser would: internal links, stylesheets,
 * scripts, fonts and RSC payloads must all answer 200 under /MATH_7th/.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSqlite } from "@/db";
import { migrate } from "../scripts/migrate";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "out");
const BASE = "/MATH_7th";

/** Prefixes that only exist behind the Node server (documented limitation). */
const SERVER_ONLY = [`${BASE}/media/`, `${BASE}/api/`, `${BASE}/admin/`];
const ASSET_EXT = /\.(css|js|mjs|woff2?|ttf|png|jpe?g|webp|svg|ico|txt|map)$/;

let tempDir = "";
let dbFile = "";
let preview: ChildProcess | undefined;
let previewPort = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function runBuild(): void {
  const res = spawnSync(process.execPath, ["scripts/build-static.mjs"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_FILE: dbFile },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `build:static failed (exit ${res.status})\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
}

function seedContent(): void {
  const sqlite = getSqlite(dbFile);
  migrate(sqlite);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO units (position, title_ar, title_en, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
    )
    .run("وحدة الاختبار المصدَّرة", "Exported test unit", now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (unit_id, position, title_ar, title_en, page_label, status, content_updated_at, created_at, updated_at)
       VALUES (1, 1, 'الدرس المنشور في التصدير', 'Published export lesson', 'ص 5', 'published', ?, ?, ?)`,
    )
    .run(now, now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (unit_id, position, title_ar, title_en, status, content_updated_at, created_at, updated_at)
       VALUES (1, 2, 'DRAFT-SECRET-MUST-NOT-APPEAR', 'DRAFT-SECRET-MUST-NOT-APPEAR', 'draft', ?, ?, ?)`,
    )
    .run(now, now, now);
  sqlite
    .prepare(
      `INSERT INTO lesson_images (lesson_id, position, storage_key, mime, width, height, sha256, state, created_at)
       VALUES (1, 1, 'lessons/1/page-01.webp', 'image/webp', 1600, 2200, 'deadbeef', 'ready', ?)`,
    )
    .run(now);
  sqlite.close();
}

function read(rel: string): string {
  return fs.readFileSync(path.join(OUT, rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(OUT, rel));
}

async function get(pathname: string): Promise<{ status: number; type: string; body: string; location: string | null }> {
  const res = await fetch(`http://localhost:${previewPort}${pathname}`, {
    redirect: "manual",
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    body: await res.text(),
    location: res.headers.get("location"),
  };
}

/** Like get(), but follows same-prefix redirects the way a browser does. */
async function getFollowing(pathname: string): Promise<Awaited<ReturnType<typeof get>>> {
  let current = pathname;
  let res = await get(current);
  for (let hops = 0; hops < 5 && res.status >= 300 && res.status < 400 && res.location; hops++) {
    const next = new URL(res.location, `http://localhost:${previewPort}`);
    current = next.pathname;
    res = await get(current);
  }
  return res;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every root-absolute URL in out/ must live under /MATH_7th/. The single
 *  exception is Next's own <link rel="preconnect" href="/"> origin hint —
 *  it points at the domain root on purpose and is not a page link. */
function basePathViolations(): string[] {
  const bad: string[] = [];
  for (const file of walk(OUT)) {
    if (!/\.(html|txt|css|js)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(OUT, file);
    for (const tag of text.matchAll(/<[a-z][^>]*>/g)) {
      const t = tag[0];
      const isPreconnect = /rel="preconnect"/.test(t);
      for (const m of t.matchAll(/(?:href|src|content)="(\/[^"]*)"/g)) {
        const url = m[1]!;
        if (url === "/" && isPreconnect) continue;
        if (!url.startsWith(`${BASE}/`)) bad.push(`${rel}: ${t.slice(0, 120)}`);
      }
    }
    for (const m of text.matchAll(/url\((\/[^)]*)\)/g)) {
      if (!m[1]!.startsWith(`${BASE}/`)) bad.push(`${rel}: url(${m[1]})`);
    }
  }
  return bad;
}

/** Crawl every internal page link starting from the given seeds. */
async function crawl(seeds: string[]): Promise<{
  pages: string[];
  broken: string[];
  serverOnly: Set<string>;
  assets: string[];
  brokenAssets: string[];
}> {
  const pages: string[] = [];
  const broken: string[] = [];
  const serverOnly = new Set<string>();
  const assets: string[] = [];
  const brokenAssets: string[] = [];
  const seen = new Set<string>();
  const queue = [...seeds];

  while (queue.length > 0) {
    const urlPath = queue.shift()!;
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);

    if (SERVER_ONLY.some((p) => urlPath.startsWith(p))) {
      serverOnly.add(urlPath);
      continue;
    }
    if (ASSET_EXT.test(urlPath)) {
      assets.push(urlPath);
      const res = await get(urlPath);
      if (res.status !== 200) brokenAssets.push(`${urlPath} → ${res.status}`);
      continue;
    }

    // Follow same-prefix redirects (e.g. hreflang links to /MATH_7th/ar,
    // which GitHub Pages 301s to /MATH_7th/ar/ — a browser follows it).
    const res = await getFollowing(urlPath);
    if (res.status !== 200) {
      broken.push(`${urlPath} → ${res.status}`);
      continue;
    }
    pages.push(urlPath);

    for (const tag of res.body.matchAll(/<[a-z][^>]*>/g)) {
      const t = tag[0];
      const isPreconnect = /rel="preconnect"/.test(t);
      for (const m of t.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const ref = m[1]!;
        if (/^(https?:|mailto:|tel:|data:)/.test(ref)) continue;
        if (ref === "/" && isPreconnect) continue; // origin hint, not a link
        if (ref.startsWith("#")) continue;
        if (!ref.startsWith("/")) continue; // relative — same-directory URL
        if (!ref.startsWith(BASE)) {
          broken.push(`${urlPath} → outside prefix: ${ref}`);
          continue;
        }
        const clean = ref.split("#")[0]!.split("?")[0]!;
        if (clean.length > BASE.length && !seen.has(clean)) queue.push(clean);
      }
    }
  }
  return { pages, broken, serverOnly, assets, brokenAssets };
}

// ── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-static-"));
  dbFile = path.join(tempDir, "static.db");
  const sqlite = getSqlite(dbFile);
  migrate(sqlite);
  sqlite.close();

  runBuild(); // ← build #1: empty content

  preview = spawn(
    process.execPath,
    ["scripts/preview-static.mjs", "--port", "0"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const ready = new Promise<void>((resolve, reject) => {
    let out = "";
    preview!.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/static-preview PORT=(\d+)/);
      if (m) {
        previewPort = Number(m[1]);
        resolve();
      }
    });
    preview!.stderr!.on("data", (d: Buffer) => process.stderr.write(d));
    preview!.on("exit", (code) => reject(new Error(`preview exited early: ${code}`)));
    setTimeout(() => reject(new Error("preview did not start in 10s")), 10_000);
  });
  return ready;
}, 300_000);

afterAll(() => {
  preview?.kill("SIGTERM");
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 1. empty content (the state this repository ships in) ─────────────────

describe("static export — empty content", () => {
  it("builds successfully and writes the GitHub Pages entry files", () => {
    expect(exists("index.html")).toBe(true);
    expect(exists(".nojekyll")).toBe(true);
    expect(exists("404.html")).toBe(true);
    expect(read("index.html")).toContain(`url=${BASE}/ar/`);
  });

  it("exports every public page for both locales", () => {
    for (const rel of [
      "ar/index.html",
      "en/index.html",
      "ar/units/index.html",
      "en/units/index.html",
      "ar/quizzes/lessons/index.html",
      "ar/quizzes/units/index.html",
      "en/quizzes/lessons/index.html",
      "en/quizzes/units/index.html",
    ]) {
      expect(exists(rel), `missing ${rel}`).toBe(true);
    }
  });

  it("renders the Arabic home page with its empty-state content", () => {
    const html = read("ar/index.html");
    expect(html).toContain("رياضيات الصف السابع");
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("لا توجد وحدات بعد"); // empty units state
  });

  it("creates no unit/lesson detail pages and no fake content", () => {
    // No content ⇒ no detail pages at all (not even placeholders).
    expect(exists("ar/units/1/index.html")).toBe(false);
    expect(exists("ar/lessons/1/index.html")).toBe(false);
    // The mandatory placeholder route renders only a noindexed 404 shell…
    const shell = read("ar/units/0/index.html");
    expect(shell).toContain("__next_error__");
    expect(shell).toContain('name="robots" content="noindex"');
    // …and nothing links to it.
    const htmls = walk(OUT).filter((f) => f.endsWith(".html"));
    for (const f of htmls) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/href="[^"]*\/units\/0/);
    }
  });

  it("keeps every URL under /MATH_7th/", () => {
    expect(basePathViolations()).toEqual([]);
  });
});

// ── 2. seeded content (temp database — never the repository's data/) ──────

describe("static export — seeded content", () => {
  beforeAll(() => {
    seedContent();
    runBuild(); // ← build #2: with one unit, one published lesson, one draft
  }, 300_000);

  it("exports the unit and published lesson pages for both locales", () => {
    for (const rel of [
      "ar/units/1/index.html",
      "en/units/1/index.html",
      "ar/lessons/1/index.html",
      "en/lessons/1/index.html",
    ]) {
      expect(exists(rel), `missing ${rel}`).toBe(true);
    }
    // Placeholder shells disappear once real content exists.
    expect(exists("ar/units/0/index.html")).toBe(false);
    expect(exists("ar/lessons/0/index.html")).toBe(false);
  });

  it("bakes real content into the HTML", () => {
    expect(read("ar/units/1/index.html")).toContain("وحدة الاختبار المصدَّرة");
    expect(read("ar/lessons/1/index.html")).toContain("الدرس المنشور في التصدير");
    expect(read("ar/units/index.html")).toContain("وحدة الاختبار المصدَّرة");
  });

  it("never exports drafts", () => {
    expect(exists("ar/lessons/2/index.html")).toBe(false);
    expect(exists("en/lessons/2/index.html")).toBe(false);
    const secret = "DRAFT-SECRET-MUST-NOT-APPEAR";
    for (const f of walk(OUT)) {
      if (!/\.(html|txt)$/.test(f)) continue;
      expect(fs.readFileSync(f, "utf8"), `draft leaked into ${f}`).not.toContain(secret);
    }
  });

  it("prefixes media URLs with /MATH_7th (server-only, but path-correct)", () => {
    const html = read("ar/lessons/1/index.html");
    const media = [...html.matchAll(/src="([^"]*\/media\/[^"]*)"/g)].map((m) => m[1]!);
    expect(media.length).toBeGreaterThan(0);
    for (const url of media) expect(url.startsWith(`${BASE}/media/`)).toBe(true);
  });

  it("keeps hreflang alternates, RTL/LTR and the base path intact", () => {
    const ar = read("ar/index.html");
    const en = read("en/index.html");
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(ar).toContain(`href="${BASE}/ar"`);
    expect(ar).toContain(`href="${BASE}/en"`);
    expect(basePathViolations()).toEqual([]);
  });

  it("resolves every referenced asset on disk under /MATH_7th/", () => {
    const missing: string[] = [];
    for (const file of walk(OUT)) {
      if (!/\.(html|txt)$/.test(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const url = m[1]!;
        if (!url.startsWith(`${BASE}/`) || ASSET_EXT.test(url) === false) continue;
        const onDisk = path.join(OUT, url.slice(BASE.length));
        if (!fs.existsSync(onDisk)) missing.push(`${path.relative(OUT, file)} → ${url}`);
      }
    }
    expect(missing).toEqual([]);

    // Fonts referenced from CSS resolve relative to the stylesheet.
    const cssFiles = walk(OUT).filter((f) => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);
    const badFonts: string[] = [];
    for (const css of cssFiles) {
      const base = path.dirname(css);
      const text = fs.readFileSync(css, "utf8");
      for (const m of text.matchAll(/url\(([^)]+)\)/g)) {
        const ref = m[1]!.replace(/["']/g, "");
        if (/^(data:|https?:)/.test(ref)) continue;
        const target = path.resolve(base, ref);
        if (!fs.existsSync(target)) badFonts.push(`${path.relative(OUT, css)} → ${ref}`);
      }
    }
    expect(badFonts).toEqual([]);
  });

  it("smoke: serves the whole site under /MATH_7th/ like GitHub Pages", async () => {
    // Bare project root redirects to the trailing-slash URL.
    const root = await get(BASE);
    expect(root.status).toBe(301);
    expect(root.body).toContain(`${BASE}/`);

    const seeds = [`${BASE}/`, `${BASE}/ar/`, `${BASE}/en/`];
    const { pages, broken, serverOnly, assets, brokenAssets } = await crawl(seeds);

    expect(broken).toEqual([]);
    expect(brokenAssets).toEqual([]);
    expect(pages).toContain(`${BASE}/ar/`);
    expect(pages).toContain(`${BASE}/ar/units/1/`);
    expect(pages).toContain(`${BASE}/ar/lessons/1/`);
    expect(pages).toContain(`${BASE}/en/units/1/`);
    expect(pages.length).toBeGreaterThanOrEqual(15);
    expect(assets.length).toBeGreaterThanOrEqual(5);
    // Media URLs are prefixed correctly but stay backend-only (documented):
    // the lesson page must link them under /MATH_7th/media/, never at root.
    expect(serverOnly.size).toBeGreaterThanOrEqual(2);
    expect([...serverOnly].every((u) => u.startsWith(`${BASE}/media/`))).toBe(true);
    expect([...serverOnly].some((u) => u === `${BASE}/media/i/1/web`)).toBe(true);

    // Stylesheets and scripts answer with the right content types.
    const ar = await get(`${BASE}/ar/`);
    const css = ar.body.match(/href="(\/MATH_7th\/_next\/[^"]+\.css)"/)![1]!;
    const cssRes = await get(css);
    expect(cssRes.status).toBe(200);
    expect(cssRes.type).toContain("text/css");
    const js = ar.body.match(/src="(\/MATH_7th\/_next\/[^"]+\.js)"/)![1]!;
    expect((await get(js)).status).toBe(200);

    // RSC payloads for client-side navigation (GitHub Pages serves them as
    // plain text — Next's export client accepts exactly that).
    const txt = await get(`${BASE}/ar/units/index.txt`);
    expect(txt.status).toBe(200);
    expect(txt.type).toContain("text/plain");

    // Unknown paths answer 404 with the exported 404 page, and nothing
    // leaks to the domain root outside the project prefix.
    const missing = await get(`${BASE}/no-such-page/`);
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("404");
    expect((await get("/ar/")).status).toBe(404);
  });
});
