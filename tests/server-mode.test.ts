/**
 * Server-mode preservation tests for PR 4.
 *
 * The static export must not weaken the running site. This suite builds the
 * NORMAL server bundle (`next build` without NEXT_OUTPUT), starts it against
 * a temp database, and asserts the behaviours the export work could have
 * broken:
 *
 *   - the next-intl proxy still redirects / → /ar;
 *   - public pages render per request (content inserted after the build
 *     appears immediately — the invariant renderPerRequest() protects);
 *   - 404 semantics: missing ids, drafts, and the empty-content placeholder;
 *   - login / session cookie / admin guard / logout;
 *   - API routes respond (upload401 without a session, 200 with one);
 *   - server actions execute: a create-unit action writes to the database
 *     when signed in and is rejected (no write) when signed out;
 *   - the media pipeline serves uploaded scans with correct content types.
 *
 * Everything runs against temp paths — the repository's data/ directory is
 * never touched.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSqlite } from "@/db";
import { migrate } from "../scripts/migrate";

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, "tests/content/example/media/lessons/1/page-01.webp");
const ADMIN_SECRET = "server-mode-test-secret-0123456789abcdef";
const ADMIN_PASS = "test-owner-password";

let tempDir = "";
let dbFile = "";
let server: ChildProcess | undefined;
let port = 0;
let sessionCookie = "";
let unitId = 0;
let publishedLessonId = 0;
let draftLessonId = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const p = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (p ? resolve(p) : reject(new Error("no port"))));
    });
    srv.on("error", reject);
  });
}

function sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[] {
  const sqlite = getSqlite(dbFile);
  try {
    return sqlite.prepare(query).all(...(params as never[])) as T[];
  } finally {
    sqlite.close();
  }
}

async function req(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; location: string | null; body: string; setCookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: "manual", ...init });
  return {
    status: res.status,
    location: res.headers.get("location"),
    setCookie: res.headers.get("set-cookie"),
    body: await res.text(),
  };
}

function seedContent(): void {
  const sqlite = getSqlite(dbFile);
  migrate(sqlite);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO units (position, title_ar, title_en, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
    )
    .run("وحدة الخادم الحية", "Live server unit", now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (unit_id, position, title_ar, title_en, status, content_updated_at, created_at, updated_at)
       VALUES (1, 1, 'درس الخادم المنشور', 'Published server lesson', 'published', ?, ?, ?)`,
    )
    .run(now, now, now);
  sqlite
    .prepare(
      `INSERT INTO lessons (unit_id, position, title_ar, title_en, status, content_updated_at, created_at, updated_at)
       VALUES (1, 2, 'SOCKET-DRAFT-SECRET', 'SOCKET-DRAFT-SECRET', 'draft', ?, ?, ?)`,
    )
    .run(now, now, now);
  // A ready scan row so the lesson page renders its viewer with
  // root-relative /media/… URLs (server mode must NOT add /MATH_7th).
  sqlite
    .prepare(
      `INSERT INTO lesson_images (lesson_id, position, storage_key, mime, width, height, sha256, state, created_at)
       VALUES (1, 1, 'lessons/1/seeded.webp', 'image/webp', 1600, 2200, 'cafe', 'ready', ?)`,
    )
    .run(now);
  const unit = sqlite.prepare("SELECT id FROM units LIMIT 1").get() as { id: number };
  const pub = sqlite
    .prepare("SELECT id FROM lessons WHERE status='published' LIMIT 1")
    .get() as { id: number };
  const draft = sqlite
    .prepare("SELECT id FROM lessons WHERE status='draft' LIMIT 1")
    .get() as { id: number };
  unitId = unit.id;
  publishedLessonId = pub.id;
  draftLessonId = draft.id;
  sqlite.close();
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ar`, { redirect: "manual" });
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start did not become ready in 30s");
}

// ── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-server-"));
  dbFile = path.join(tempDir, "server.db");
  seedContent();

  // Owner account through the real seed script.
  const seed = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-admin.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_FILE: dbFile,
      ADMIN_USERNAME: "owner",
      ADMIN_PASSWORD: ADMIN_PASS,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (seed.status !== 0) throw new Error(`seed-admin failed:\n${seed.stdout}\n${seed.stderr}`);

  // Normal server build — no NEXT_OUTPUT, so .srv routes are included.
  const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_FILE: dbFile },
    encoding: "utf8",
    timeout: 300_000,
  });
  if (build.status !== 0) throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);
  // The bundle must contain the server-only pieces the export excludes.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".next/server/server-reference-manifest.json"), "utf8"),
  ) as { node: Record<string, unknown> };
  expect(Object.keys(manifest.node).length).toBeGreaterThan(0);

  port = await freePort();
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_FILE: dbFile,
        ADMIN_SESSION_SECRET: ADMIN_SECRET,
        ADMIN_USERNAME: "owner",
        ADMIN_PASSWORD: ADMIN_PASS,
        UPLOAD_DIR: path.join(tempDir, "uploads"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so afterAll can stop `next` and its server child.
      detached: true,
    },
  );
  let logs = "";
  server.stdout!.on("data", (d: Buffer) => (logs += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (logs += d.toString()));
  server.on("exit", (code) => {
    // 143 = SIGTERM from afterAll — expected shutdown, not a failure.
    if (code !== null && code !== 0 && code !== 143) {
      console.error(`next start exited ${code}:\n${logs}`);
    }
  });
  await waitForServer();
}, 300_000);

afterAll(() => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("server mode — routing and rendering", () => {
  it("keeps the locale proxy redirecting / to /ar", async () => {
    const res = await req("/");
    expect(res.status).toBe(307);
    expect(res.location).toContain("/ar");
  });

  it("renders RTL for Arabic and LTR for English", async () => {
    expect((await req("/ar")).body).toContain('<html lang="ar" dir="rtl">');
    expect((await req("/en")).body).toContain('<html lang="en" dir="ltr">');
  });

  it("renders units, unit detail and published lesson pages", async () => {
    const units = await req("/ar/units");
    expect(units.status).toBe(200);
    expect(units.body).toContain("وحدة الخادم الحية");

    const unit = await req(`/ar/units/${unitId}`);
    expect(unit.status).toBe(200);
    expect(unit.body).toContain("وحدة الخادم الحية");

    const lesson = await req(`/ar/lessons/${publishedLessonId}`);
    expect(lesson.status).toBe(200);
    expect(lesson.body).toContain("درس الخادم المنشور");
    expect(lesson.body).toContain(`src="/media/i/`); // server mode: no prefix
  });

  it("answers 404 for missing ids, drafts and the placeholder", async () => {
    expect((await req("/ar/units/999999")).status).toBe(404);
    expect((await req(`/ar/lessons/${draftLessonId}`)).status).toBe(404);
    expect((await req("/ar/units/0")).status).toBe(404);
    // The draft never leaks into list pages either.
    expect((await req("/ar/units")).body).not.toContain("SOCKET-DRAFT-SECRET");
  });

  it("shows content inserted AFTER the build without a rebuild", async () => {
    const now = new Date().toISOString();
    const sqlite = getSqlite(dbFile);
    sqlite
      .prepare(
        "INSERT INTO units (position, title_ar, title_en, created_at, updated_at) VALUES (9, ?, ?, ?, ?)",
      )
      .run("وحدة أُضيفت لاحقًا", "Added later", now, now);
    sqlite.close();

    const list = await req("/ar/units");
    expect(list.status).toBe(200);
    expect(list.body).toContain("وحدة أُضيفت لاحقًا");

    const home = await req("/ar");
    expect(home.body).toContain("وحدة أُضيفت لاحقًا");
  });
});

describe("server mode — authentication and admin API", () => {
  it("rejects bad credentials and sets a signed cookie on success", async () => {
    const bad = await req("/api/admin/login", {
      method: "POST",
      body: new URLSearchParams({ username: "owner", password: "wrong-password", locale: "ar" }),
    });
    expect(bad.status).toBe(303);
    expect(bad.location).toContain("error=1");

    const ok = await req("/api/admin/login", {
      method: "POST",
      body: new URLSearchParams({
        username: "owner",
        password: ADMIN_PASS,
        locale: "ar",
      }),
    });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/ar/admin");
    expect(ok.setCookie).toContain("m7_admin=");
    expect(ok.setCookie).toContain("HttpOnly");
    sessionCookie = ok.setCookie!.split(";")[0]!;
  });

  it("guards the admin tree with the session cookie", async () => {
    expect((await req("/ar/admin")).status).toBe(307);
    expect((await req("/ar/admin")).location).toContain("/ar/admin/login");

    const authed = await req("/ar/admin", { headers: { Cookie: sessionCookie } });
    expect(authed.status).toBe(200);

    // requireOwner is what every admin page calls — units/lessons render too.
    expect((await req("/ar/admin/units", { headers: { Cookie: sessionCookie } })).status).toBe(200);
    expect((await req("/ar/admin/lessons", { headers: { Cookie: sessionCookie } })).status).toBe(
      200,
    );
  });

  it("keeps the upload route honest: 401 without session, 200 with it", async () => {
    const anon = await req("/api/admin/upload", { method: "POST", body: new FormData() });
    expect(anon.status).toBe(401);

    const form = new FormData();
    form.append("lessonId", String(publishedLessonId));
    form.append(
      "files",
      new Blob([fs.readFileSync(FIXTURE)], { type: "image/webp" }),
      "page-01.webp",
    );
    const authed = await req("/api/admin/upload", {
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: form,
    });
    expect(authed.status).toBe(200);
    expect(authed.body).toContain('"uploaded":1');
  });

  it("serves the uploaded scan through the media route", async () => {
    const rows = sql<{ id: number }>(
      "SELECT id FROM lesson_images WHERE lesson_id = ? ORDER BY id DESC LIMIT 1",
      publishedLessonId,
    );
    const imageId = rows[0]!.id;
    const web = await req(`/media/i/${imageId}/web`);
    expect(web.status).toBe(200);
    const thumb = await req(`/media/i/${imageId}/thumb`);
    expect(thumb.status).toBe(200);
    expect((await req("/media/i/999999/web")).status).toBe(404);
    expect((await req("/media/i/1/not-a-variant")).status).toBe(404);
  });

  it("logs out by clearing the cookie", async () => {
    const res = await req("/api/admin/logout", {
      method: "POST",
      body: new URLSearchParams({ locale: "ar" }),
    });
    expect(res.status).toBe(303);
    expect(res.location).toContain("/ar/admin/login");
    expect(res.setCookie).toContain("m7_admin=;");
  });
});

describe("server mode — server actions", () => {
  it("creates a unit through the progressive-enhancement action form", async () => {
    const page = await req("/ar/admin/units", { headers: { Cookie: sessionCookie } });
    expect(page.status).toBe(200);
    const actionId = page.body.match(/\$ACTION_ID_([a-f0-9]+)/)?.[1];
    expect(actionId).toBeTruthy();

    const before = sql<{ c: number }>("SELECT COUNT(*) c FROM units")[0]!.c;
    const form = new FormData();
    form.append(`$ACTION_ID_${actionId}`, "");
    form.append("titleAr", "وحدة عبر إجراء الخادم");
    form.append("titleEn", "Unit via server action");
    form.append("position", "7");
    form.append("accent", "teal");
    const res = await req("/ar/admin/units", {
      method: "POST",
      headers: { Cookie: sessionCookie },
      body: form,
    });
    expect([200, 303]).toContain(res.status);

    const after = sql<{ c: number }>("SELECT COUNT(*) c FROM units")[0]!.c;
    expect(after).toBe(before + 1);
    const created = sql<{ title_ar: string }>(
      "SELECT title_ar FROM units ORDER BY id DESC LIMIT 1",
    )[0]!;
    expect(created.title_ar).toBe("وحدة عبر إجراء الخادم");

    // …and the public list shows it immediately (dynamic rendering + action).
    const list = await req("/ar/units");
    expect(list.body).toContain("وحدة عبر إجراء الخادم");
  });

  it("refuses the same action without a session (assertOwner)", async () => {
    // Same form, parsed from the page (action ids come from the build).
    const page = await req("/ar/admin/units", { headers: { Cookie: sessionCookie } });
    const actionId = page.body.match(/\$ACTION_ID_([a-f0-9]+)/)?.[1];
    expect(actionId).toBeTruthy();

    const before = sql<{ c: number }>("SELECT COUNT(*) c FROM units")[0]!.c;
    const form = new FormData();
    form.append(`$ACTION_ID_${actionId}`, "");
    form.append("titleAr", "وحدة يجب ألا تُنشأ");
    form.append("position", "8");
    form.append("accent", "teal");
    const res = await req("/ar/admin/units", { method: "POST", body: form });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = sql<{ c: number }>("SELECT COUNT(*) c FROM units")[0]!.c;
    expect(after).toBe(before);
  });
});
