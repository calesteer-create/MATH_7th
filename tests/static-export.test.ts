/**
 * Static export (GitHub Pages) verification for PR 4.
 *
 * Runs the real pipeline — `scripts/build-static.mjs` (migrate → next build
 * with output:"export" → root redirect → .nojekyll) — twice:
 *
 *   1. empty content  — the repository ships no curriculum; the export must
 *      still succeed, link cleanly, and expose no placeholder as real content;
 *   2. seeded content — one unit, one published lesson, one draft and two
 *      scans written into a TEMP content tree (never the repository's own
 *      content/ or public/media/) — proving that real pages export, that the
 *      published scans become plain files under /MATH_7th/media/lessons/…,
 *      that drafts stay hidden, and that every URL lives under /MATH_7th/.
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
import crypto from "node:crypto";
import { getSqlite } from "@/db";
import { migrate } from "../scripts/migrate";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "out");
const FIXTURE = path.join(ROOT, "tests/content/example/media/lessons/1/page-01.webp");
/** Sentinel that must never reach the public artefact. */
const DRAFT_SENTINEL = "DRAFT-SECRET-MUST-NOT-APPEAR";
const PAGES_DIST = path.join(ROOT, "pages-dist");
const BASE = "/MATH_7th";

/** Prefixes that only exist behind the Node server (documented limitation). */
const SERVER_ONLY = [`${BASE}/media/i/`, `${BASE}/api/`, `${BASE}/admin/`];
const ASSET_EXT = /\.(css|js|mjs|woff2?|ttf|png|jpe?g|webp|svg|ico|txt|map)$/;

let tempDir = "";
let dbFile = "";
let preview: ChildProcess | undefined;
let previewPort = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function runBuild(): void {
  const res = spawnSync(process.execPath, ["scripts/build-static.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_FILE: dbFile,
      CONTENT_ROOT: path.join(tempDir, "content"),
      MEDIA_ROOT: path.join(tempDir, "media"),
    },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `build:static failed (exit ${res.status})\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
}

function runPagesArtifact(command: "prepare" | "audit", cwd = ROOT) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "pages-artifact.mjs"), command], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
}

/**
 * Writes a throwaway content tree for the seeded build.
 *
 * The published site reads `content/*.json` (src/content/source.ts), so the
 * fixture is a tree, not a database. The scan bytes are the repository's own
 * reference example (already labelled as a structural sample) copied under
 * temp paths — no curriculum content is created anywhere.
 */
function seedContent(): void {
  const contentRoot = path.join(tempDir, "content");
  const mediaRoot = path.join(tempDir, "media");
  const now = new Date().toISOString();
  const lessonFolder = path.join(mediaRoot, "lessons", "1");
  fs.mkdirSync(path.join(lessonFolder, "thumbs"), { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "units"), { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "lessons"), { recursive: true });

  const bytes = fs.readFileSync(FIXTURE);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  for (const position of [1, 2]) {
    const file = `page-0${position}.webp`;
    fs.copyFileSync(FIXTURE, path.join(lessonFolder, file));
    fs.copyFileSync(FIXTURE, path.join(lessonFolder, "thumbs", file));
  }
  const images = [1, 2].map((position) => ({
    position,
    file: `page-0${position}.webp`,
    thumb: `thumbs/page-0${position}.webp`,
    width: 220,
    height: 300,
    bytes: bytes.byteLength,
    sha256: sha,
  }));

  fs.writeFileSync(
    path.join(contentRoot, "units", "1.json"),
    JSON.stringify(
      {
        id: 1,
        position: 1,
        titleAr: "وحدة الاختبار المصدَّرة",
        titleEn: "Exported test unit",
        descriptionAr: "",
        descriptionEn: "",
        pageFrom: "5",
        pageTo: "9",
        accent: "teal",
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );
  const lesson = (id: number, position: number, titleAr: string, status: string, lessonImages: unknown[]) => ({
    id,
    unitId: 1,
    position,
    titleAr,
    titleEn: titleAr,
    pageLabel: "ص 5",
    status,
    isLastInUnit: false,
    publishedAt: status === "published" ? now : null,
    contentUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    images: lessonImages,
  });
  fs.writeFileSync(
    path.join(contentRoot, "lessons", "1.json"),
    JSON.stringify(lesson(1, 1, "الدرس المنشور في التصدير", "published", images), null, 2),
  );
  fs.writeFileSync(
    path.join(contentRoot, "lessons", "2.json"),
    JSON.stringify(
      lesson(2, 2, DRAFT_SENTINEL, "draft", []),
      null,
      2,
    ),
  );
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

  it("ships both contact bars on every exported public page, in both locales", () => {
    const pages = walk(OUT).filter(
      (f) => f.endsWith(".html") && /(^|\/)(ar|en)\//.test(path.relative(OUT, f)),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const file of pages) {
      const html = fs.readFileSync(file, "utf8");
      // The placeholder 404 shells are Next error pages, not site pages.
      if (html.includes("__next_error__")) continue;
      const rel = path.relative(OUT, file);
      expect(html, `${rel} top bar`).toContain("contact-bar-top");
      expect(html, `${rel} bottom bar`).toContain("contact-bar-bottom");
      expect(html, `${rel} WhatsApp URL`).toContain("https://wa.me/963930215022");
      expect(html, `${rel} safe new tab`).toContain('rel="noopener noreferrer"');
      expect(html, `${rel} space reservation`).toContain("contact-reserve");
    }
  });

  it("compiles the contact layout and the unit accents into the real stylesheet", () => {
    const css = walk(OUT)
      .filter((f) => f.endsWith(".css"))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    expect(css).toContain("contact-bar-top");
    expect(css).toContain("contact-bar-bottom");
    expect(css).toContain("contact-reserve");
    expect(css).toContain("env(safe-area-inset-bottom");
    // Consumed via inline `var(--color-unit-*)`: must survive tree-shaking.
    for (const accent of ["teal", "sky", "indigo", "violet", "rose", "amber", "emerald", "cyan"]) {
      expect(css, `--color-unit-${accent}`).toContain(`--color-unit-${accent}:`);
    }
  });

  it("prepares and audits the exact upload artifact without admin or server-only paths", () => {
    const prepared = runPagesArtifact("prepare");
    expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    const audited = runPagesArtifact("audit");
    expect(audited.status, `${audited.stdout}\n${audited.stderr}`).toBe(0);

    const artifactFiles = walk(PAGES_DIST).map((file) => path.relative(PAGES_DIST, file));
    const exportFiles = walk(OUT)
      .map((file) => path.relative(OUT, file))
      .filter((rel) => !rel.startsWith("admin/"));
    expect(artifactFiles.sort()).toEqual(exportFiles.sort());

    expect(fs.existsSync(path.join(PAGES_DIST, ".nojekyll"))).toBe(true);
    expect(fs.existsSync(path.join(PAGES_DIST, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(PAGES_DIST, "404.html"))).toBe(true);
    expect(fs.existsSync(path.join(PAGES_DIST, "ar/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(PAGES_DIST, "en/index.html"))).toBe(true);
    expect(artifactFiles.some((rel) => rel.startsWith("_next/"))).toBe(true);

    for (const rel of artifactFiles) {
      expect(rel, `server-only or sensitive path leaked: ${rel}`).not.toMatch(
        /(^|\/)(admin|api|data)(\/|$)|(^|\/)media\/i(\/|$)|(^|\/)\.env|\.db(?:[-_]|$)/i,
      );
      const hidden = rel.split("/").some((segment) => segment.startsWith("."));
      if (hidden) expect(rel).toBe(".nojekyll");
      expect(fs.lstatSync(path.join(PAGES_DIST, rel)).isSymbolicLink(), `symlink leaked: ${rel}`).toBe(false);
    }
  });
});

// ── 2. seeded content (temp content tree — never the repository's) ────────

describe("static export — seeded content", () => {
  beforeAll(() => {
    seedContent();
    runBuild(); // ← build #2: one unit, one published lesson, one draft, 2 scans
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
    const secret = DRAFT_SENTINEL;
    for (const f of walk(OUT)) {
      if (!/\.(html|txt)$/.test(f)) continue;
      expect(fs.readFileSync(f, "utf8"), `draft leaked into ${f}`).not.toContain(secret);
    }
  });

  it("serves lesson scans as plain files under /MATH_7th/media/lessons/", () => {
    const html = read("ar/lessons/1/index.html");
    const media = [...html.matchAll(/src="([^"]*\/media\/[^"]*)"/g)].map((m) => m[1]!);
    expect(media.length).toBeGreaterThan(0);
    for (const url of media) {
      expect(url.startsWith(`${BASE}/media/lessons/1/`)).toBe(true);
      // Every referenced scan must exist on disk: a broken image is a failure.
      expect(fs.existsSync(path.join(OUT, url.slice(BASE.length))), `missing ${url}`).toBe(true);
    }
    // …and the served bytes are the imported WebP, not a placeholder.
    const onDisk = fs.readFileSync(path.join(OUT, media[0]!.slice(BASE.length)));
    expect(onDisk.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(onDisk.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  it("never publishes a scan the content tree does not reference", () => {
    // The temp media root also holds an unreferenced file; only referenced
    // scans may be copied, so an orphan never becomes public.
    const published = walk(path.join(OUT, "media")).map((f) =>
      path.relative(OUT, f).split(path.sep).join("/"),
    );
    expect(published.sort()).toEqual([
      "media/lessons/1/page-01.webp",
      "media/lessons/1/page-02.webp",
      "media/lessons/1/thumbs/page-01.webp",
      "media/lessons/1/thumbs/page-02.webp",
    ]);
  });

  it("fails closed instead of preparing an artifact that references server-only media", () => {
    // Server-only `/media/i/…` must never become a public artifact; the static
    // scan tree is the only media shape the audit accepts.
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "math7-pages-seeded-"));
    try {
      const copy = path.join(isolated, "out");
      fs.cpSync(OUT, copy, { recursive: true });
      const page = path.join(copy, "ar/lessons/1/index.html");
      fs.writeFileSync(
        page,
        fs.readFileSync(page, "utf8").replace(`${BASE}/media/lessons/1/`, `${BASE}/media/i/1/`),
      );
      const res = runPagesArtifact("prepare", isolated);
      expect(res.status, `${res.stdout}\n${res.stderr}`).not.toBe(0);
      expect(`${res.stdout}\n${res.stderr}`).toMatch(/server-only route reference|forbidden server-only/);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
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
    // Lesson scans are real files on the published site, so the crawler must
    // have fetched them successfully (they are no longer server-only).
    expect(assets.some((u) => u.startsWith(`${BASE}/media/lessons/1/`))).toBe(true);
    // Nothing server-only may be linked from a published page.
    expect([...serverOnly]).toEqual([]);

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
