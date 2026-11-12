/**
 * GitHub Pages artifact boundary tests.
 *
 * These run the real `scripts/pages-artifact.mjs` CLI in disposable temporary
 * working directories. They prove that the uploaded tree is not merely "what
 * Next happened to export": admin is excluded, server-only paths fail, hidden
 * files fail unless they are the root `.nojekyll`, symlinks fail, and sensitive
 * content fails before upload.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "pages-artifact.mjs");
const PREVIEW = path.join(ROOT, "scripts", "preview-static.mjs");
const BASE = "/MATH_7th";

const temps: string[] = [];
const previews: ChildProcess[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-pages-artifact-"));
  temps.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string | Buffer = ""): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Minimal valid public export fixture. No curriculum content is added. */
function validOut(root: string): void {
  write(root, "out/index.html", `<!doctype html><meta http-equiv="refresh" content="0; url=${BASE}/ar/">`);
  write(root, "out/404.html", "<!doctype html><title>404</title>");
  write(root, "out/.nojekyll", "");
  write(root, "out/ar/index.html", '<!doctype html><html lang="ar" dir="rtl"></html>');
  write(root, "out/en/index.html", '<!doctype html><html lang="en" dir="ltr"></html>');
  write(root, "out/_next/static/chunks/app.js", "console.log('public');");
  write(root, "out/_next/static/media/font.woff2", Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  write(root, "out/ar/index.txt", "public-rsc-payload");
}

function run(root: string, command: "prepare" | "audit") {
  return spawnSync(process.execPath, [SCRIPT, command], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function expectFailure(root: string, command: "prepare" | "audit", pattern: RegExp): void {
  const res = run(root, command);
  expect(res.status, `${command} unexpectedly succeeded\n${res.stdout}\n${res.stderr}`).not.toBe(0);
  expect(`${res.stdout}\n${res.stderr}`).toMatch(pattern);
}

afterEach(() => {
  for (const child of previews.splice(0)) child.kill("SIGTERM");
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pages-artifact prepare", () => {
  it("copies the public export, excludes admin/ and keeps .nojekyll", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/admin/index.html", "<!doctype html><title>experimental editor</title>");
    write(root, "out/admin/config.yml", "backend:\n  repo: calesteer-create/MATH_7th-drafts\n");

    const res = run(root, "prepare");
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(root, "pages-dist/.nojekyll"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pages-dist/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pages-dist/ar/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pages-dist/en/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pages-dist/admin"))).toBe(false);
    expect(fs.existsSync(path.join(root, "pages-dist/api"))).toBe(false);
    expect(fs.existsSync(path.join(root, "pages-dist/media/i"))).toBe(false);

    const audit = run(root, "audit");
    expect(audit.status, `${audit.stdout}\n${audit.stderr}`).toBe(0);
  });

  it("is idempotent and replaces a previous generated artifact", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    write(root, "pages-dist/stale.html", "stale");
    expect(run(root, "prepare").status).toBe(0);
    expect(fs.existsSync(path.join(root, "pages-dist/stale.html"))).toBe(false);
  });

  it("fails when out/ is missing", () => {
    const root = tempRoot();
    expectFailure(root, "prepare", /out\/ does not exist/);
  });

  it("fails on a symlinked out/ directory", () => {
    const root = tempRoot();
    const real = path.join(root, "real-out");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, "out"), "dir");
    expectFailure(root, "prepare", /out\/ must be a real directory/);
  });

  it("fails on a symlinked pages-dist/ destination", () => {
    const root = tempRoot();
    validOut(root);
    const real = path.join(root, "real-dist");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, "pages-dist"), "dir");
    expectFailure(root, "prepare", /pages-dist\/ exists but is not a real directory/);
  });
});

describe("pages-artifact audit fails closed", () => {
  it("passes a clean prepared artifact", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    expect(run(root, "audit").status).toBe(0);
  });

  it("fails when pages-dist/ is missing", () => {
    const root = tempRoot();
    expectFailure(root, "audit", /pages-dist\/ does not exist/);
  });

  it("fails when .nojekyll is missing", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    fs.rmSync(path.join(root, "pages-dist/.nojekyll"));
    expectFailure(root, "audit", /required artifact file is missing: \.nojekyll/);
  });

  for (const required of ["index.html", "404.html", "ar/index.html", "en/index.html"]) {
    it(`fails when required ${required} is missing`, () => {
      const root = tempRoot();
      validOut(root);
      expect(run(root, "prepare").status).toBe(0);
      fs.rmSync(path.join(root, `pages-dist/${required}`));
      expectFailure(root, "audit", new RegExp(`required artifact file is missing: ${required.replace("/", "\\/")}`));
    });
  }

  it("fails when _next/ is missing or empty", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    fs.rmSync(path.join(root, "pages-dist/_next"), { recursive: true, force: true });
    expectFailure(root, "audit", /required artifact directory is missing or empty: _next\//);

    fs.mkdirSync(path.join(root, "pages-dist/_next"), { recursive: true });
    expectFailure(root, "audit", /required artifact directory is missing or empty: _next\//);
  });

  const forbiddenEntries: Array<[string, string]> = [
    ["admin/index.html", "admin panel"],
    ["api/admin/login/index.html", "api route"],
    ["media/i/1/web", "server media route"],
    ["data/math7.db", "database"],
    ["ar/data.db-wal", "database sidecar"],
    [".env", "env file"],
    ["ar/.env.local", "nested env file"],
    [".git/config", "git metadata"],
    [".github/workflows/pages.yml", "workflow metadata"],
    ["ar/.hidden", "unapproved hidden file"],
    ["_next/.secret", "hidden file under assets"],
    ["ar/session-secret.txt", "sensitive basename"],
    ["ar/passwords.txt", "plural sensitive basename"],
    ["ar/private-key.pem", "key material"],
    ["ar/source.tsx", "source file"],
    ["ar/bundle.js.map", "source map"],
    ["ar/Admin/index.html", "case-variant admin segment"],
    ["ar/Media/I/1/web", "case-variant server media segment"],
    ["unexpected.html", "unexpected root file"],
  ];

  for (const [rel, label] of forbiddenEntries) {
    it(`rejects ${label} (${rel}) in the final artifact`, () => {
      const root = tempRoot();
      validOut(root);
      expect(run(root, "prepare").status).toBe(0);
      write(root, `pages-dist/${rel}`, "forbidden");
      expectFailure(root, "audit", /disallowed artifact entry/);
    });
  }

  it("rejects a symlink inside the final artifact", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    fs.symlinkSync("index.html", path.join(root, "pages-dist/ar/link.html"));
    expectFailure(root, "audit", /symlink is not allowed/);
  });

  it("rejects a symlink inside the export before copying", () => {
    const root = tempRoot();
    validOut(root);
    fs.symlinkSync("index.html", path.join(root, "out/ar/link.html"));
    expectFailure(root, "prepare", /symlink is not allowed/);
  });

  it("rejects a dangling symlink inside the final artifact", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    fs.symlinkSync("missing.html", path.join(root, "pages-dist/ar/dangling.html"));
    expectFailure(root, "audit", /symlink is not allowed/);
  });

  it("rejects private editorial repository markers in public text", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.html", "calesteer-create/MATH_7th-drafts");
    expectFailure(root, "prepare", /private editorial repository marker/);
  });

  it("rejects the draft sentinel in public text", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.txt", "DRAFT-SECRET-MUST-NOT-APPEAR");
    expectFailure(root, "prepare", /draft content sentinel/);
  });

  const forbiddenReferences: Array<[string, string]> = [
    ['<a href="/MATH_7th/admin/">admin</a>', "admin href"],
    ['<script src="/MATH_7th/api/admin/login/"></script>', "api src"],
    ['<img src="/MATH_7th/media/i/1/web">', "server media src"],
    ['<meta http-equiv="refresh" content="0; url=/MATH_7th/admin/">', "admin meta refresh"],
  ];
  for (const [html, label] of forbiddenReferences) {
    it(`rejects a forbidden ${label} in HTML`, () => {
      const root = tempRoot();
      validOut(root);
      write(root, "out/ar/index.html", html);
      expectFailure(root, "prepare", /server-only route reference|forbidden server-only/);
    });
  }

  it("rejects root-absolute HTML references outside the Pages base path", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.html", '<link rel="stylesheet" href="/_next/static/chunks/app.css">');
    expectFailure(root, "prepare", /outside \/MATH_7th\//);
  });

  it("rejects root-absolute CSS references outside the Pages base path", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/_next/static/chunks/app.css", "body{background:url(/images/bg.png)}");
    expectFailure(root, "prepare", /outside \/MATH_7th\//);
  });

  it("allows Next's origin-only preconnect hint", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.html", '<!doctype html><link rel="preconnect" href="/">');
    expect(run(root, "prepare").status).toBe(0);
    expect(run(root, "audit").status).toBe(0);
  });

  it("rejects GitHub token shapes without printing the value", () => {
    const root = tempRoot();
    validOut(root);
    const fakeToken = `ghp_${"A".repeat(36)}`;
    write(root, "out/ar/index.txt", fakeToken);
    const res = run(root, "prepare");
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}\n${res.stderr}`).toMatch(/GitHub token shape/);
    expect(`${res.stdout}\n${res.stderr}`).not.toContain(fakeToken);
  });

  it("rejects private key blocks", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.txt", "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----");
    expectFailure(root, "prepare", /private key block/);
  });

  it("rejects secret assignments", () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/ar/index.txt", 'ADMIN_SESSION_SECRET="super-secret-value"');
    expectFailure(root, "prepare", /secret assignment/);
  });

  it("rejects an oversized artifact", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    // Sparse file: over the Pages limit without allocating a gigabyte on disk.
    const fd = fs.openSync(path.join(root, "pages-dist/_next/static/chunks/huge.js"), "w");
    fs.ftruncateSync(fd, 1_000_000_001);
    fs.closeSync(fd);
    expectFailure(root, "audit", /too large for GitHub Pages/);
  });

  it("rejects a text asset too large to scan safely", () => {
    const root = tempRoot();
    validOut(root);
    expect(run(root, "prepare").status).toBe(0);
    const fd = fs.openSync(path.join(root, "pages-dist/_next/static/chunks/huge.js"), "w");
    fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    expectFailure(root, "audit", /text asset is too large to audit safely/);
  });

  const forbiddenExportEntries: Array<[string, RegExp]> = [
    ["api/admin/login/index.html", /disallowed export entry/],
    [".env.local", /disallowed export entry/],
    ["ar/math7.db", /disallowed export entry/],
    ["ar/.hidden", /disallowed export entry/],
    ["ar/Admin/index.html", /disallowed export entry/],
  ];
  for (const [rel, pattern] of forbiddenExportEntries) {
    it(`rejects ${rel} in the raw export before copying`, () => {
      const root = tempRoot();
      validOut(root);
      write(root, `out/${rel}`, "forbidden");
      expectFailure(root, "prepare", pattern);
    });
  }
});

describe("prepared artifact over a Pages-like HTTP server", () => {
  it("serves the public site and answers 404 for admin, api and server media", async () => {
    const root = tempRoot();
    validOut(root);
    write(root, "out/admin/index.html", "experimental editor");
    write(root, "out/admin/config.yml", "backend:\n  repo: calesteer-create/MATH_7th-drafts\n");
    expect(run(root, "prepare").status).toBe(0);

    // preview-static serves <cwd>/out. Give it a disposable cwd whose out/ is
    // exactly the prepared artifact, without changing the preview script.
    const serveRoot = tempRoot();
    fs.cpSync(path.join(root, "pages-dist"), path.join(serveRoot, "out"), { recursive: true });

    const child = spawn(process.execPath, [PREVIEW, "--port", "0"], {
      cwd: serveRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    previews.push(child);

    const port = await new Promise<number>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("preview did not start")), 10_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = text.match(/static-preview PORT=(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`preview exited early: ${code}`));
      });
    });

    const get = async (pathname: string) => {
      const res = await fetch(`http://localhost:${port}${pathname}`, { redirect: "manual" });
      return { status: res.status, body: await res.text() };
    };

    expect((await get(`${BASE}/`)).status).toBe(200);
    expect((await get(`${BASE}/ar/`)).status).toBe(200);
    expect((await get(`${BASE}/en/`)).status).toBe(200);
    expect((await get(`${BASE}/_next/static/chunks/app.js`)).status).toBe(200);

    for (const forbidden of [`${BASE}/admin/`, `${BASE}/api/`, `${BASE}/api/admin/login/`, `${BASE}/media/i/1/web`]) {
      const res = await get(forbidden);
      expect(res.status, forbidden).toBe(404);
      expect(res.body).not.toContain("experimental editor");
      expect(res.body).not.toContain("MATH_7th-drafts");
    }
  }, 20_000);
});
