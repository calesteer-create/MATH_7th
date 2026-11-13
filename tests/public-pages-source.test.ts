/**
 * Public pages read the content seam — and nothing else.
 *
 * `src/content/source.ts` is the only place that decides whether content comes
 * from the JSON tree (published site) or SQLite (running server). A single page
 * importing `@/lib/queries` directly would therefore read the *database* while
 * its neighbours read the tree, and the two hosts would silently disagree about
 * what the site contains.
 *
 * This is a source-level guard, in the spirit of `scripts/guard.mjs`: cheap,
 * deterministic, and impossible to forget. The admin tree is exempt on purpose —
 * it is a server-only feature that edits the database by design.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|srv\.tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Server-only editors and API routes: they own the database by design. */
function isOwnerOnlySurface(rel: string): boolean {
  const parts = rel.split(path.sep);
  return (
    parts.includes("admin") ||
    parts.includes("api") ||
    rel.endsWith(".srv.ts") ||
    rel.endsWith(".srv.tsx")
  );
}

describe("public pages and the content seam", () => {
  const files = walk(SRC).map((full) => path.relative(SRC, full));

  it("never imports the database query layer from a public page or component", () => {
    const offenders = files
      .filter((rel) => !isOwnerOnlySurface(rel))
      .filter((rel) => {
        const text = fs.readFileSync(path.join(SRC, rel), "utf8");
        return /from\s+["']@\/lib\/queries["']/.test(text);
      });
    expect(
      offenders,
      `these files must import @/content/source instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("imports the seam from the pages that display content", () => {
    for (const rel of [
      "app/[locale]/page.tsx",
      "app/[locale]/units/page.tsx",
      "app/[locale]/units/[unitId]/page.tsx",
      "app/[locale]/lessons/[lessonId]/page.tsx",
    ]) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      expect(text, rel).toMatch(/from\s+["']@\/content\/source["']/);
    }
  });

  it("addresses lesson scans through the one URL helper, never inline", () => {
    // A hand-built `/media/i/…` string in a public page would bypass the mode
    // decision in src/lib/scan-url.ts and ship a URL that 404s on Pages.
    // Comments are stripped first: documenting the route is not building it.
    const ownUrlBuilder = path.join("lib", "scan-url.ts");
    const offenders = files
      .filter((rel) => !isOwnerOnlySurface(rel) && rel !== ownUrlBuilder)
      .filter((rel) => {
        const code = fs
          .readFileSync(path.join(SRC, rel), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")
          .replace(/\/\/.*$/gm, "");
        return /["'`]\/media\/i\//.test(code);
      });
    expect(offenders, `scan URLs must come from scanUrl():\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("keeps the mode decision in one place", () => {
    // Only base-path.ts may read the build markers directly; everything else
    // must ask isStaticExport()/BASE_PATH so the two hosts cannot diverge.
    const direct = files.filter((rel) => {
      if (rel === path.join("lib", "base-path.ts")) return false;
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      return /process\.env\.(NEXT_OUTPUT|NEXT_STATIC_EXPORT)/.test(text);
    });
    expect(direct, `read build markers via src/lib/base-path.ts:\n  ${direct.join("\n  ")}`).toEqual([]);
  });
});
