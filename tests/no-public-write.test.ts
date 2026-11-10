/**
 * Requirement 5/10: nothing in PR 5 may write to the public repository or the
 * public branch, and no draft edit may trigger an automatic publish.
 *
 * These checks are structural on purpose — they assert on the repository
 * itself (config, workflows, scripts, generated CMS config), so a future edit
 * that quietly reintroduces a public write path fails CI instead of shipping.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { DRAFT_REPO_DEFAULT, PUBLIC_REPO, isWritableTarget, resolveDraftRepo } from "@/media/repo-guard";

const ROOT = process.cwd();

function walk(dir: string, filter: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === "out") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(ROOT, (file) => /\.(ts|tsx|mts|mjs|js|yml|yaml|json|html)$/.test(file)).filter(
  (file) => !file.includes(`${path.sep}content${path.sep}`),
);

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("no code path writes to the public repository", () => {
  it("only mentions the public repo in comments, guards and docs", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (relative(file).startsWith("tests/")) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(PUBLIC_REPO)) continue;
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (!line.includes(PUBLIC_REPO)) return;
        // The drafts repo name contains the public repo name as a substring
        // ("MATH_7th" inside "MATH_7th-drafts"); only a standalone mention is
        // interesting.
        const mentionedPublic = line.replace(/MATH_7th-drafts/g, "").includes(PUBLIC_REPO);
        if (!mentionedPublic) return;
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("#");
        // Declaring/asserting the forbidden value is the guard itself.
        const isDeclaration =
          /PUBLIC_REPO\s*=|classifyRepo|isWritableTarget|blockedReason|refusing|PUBLIC repository/i.test(line);
        const isTestExpectation = /expect\(|\.test\.|\.spec\./.test(relative(file));
        if (!isComment && !isDeclaration && !isTestExpectation) {
          offenders.push(`${relative(file)}:${index + 1}: ${trimmed.slice(0, 120)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never selects the public repository as a write target", () => {
    expect(isWritableTarget(PUBLIC_REPO)).toBe(false);
    expect(isWritableTarget("calesteer-create/MATH_7th.git")).toBe(false);
    expect(isWritableTarget(DRAFT_REPO_DEFAULT)).toBe(true);
    expect(resolveDraftRepo({ DRAFT_REPO: PUBLIC_REPO }).problem).toMatch(/PUBLIC repository/);
    // Case variants must not slip through.
    expect(resolveDraftRepo({ DRAFT_REPO: "Calesteer-Create/MATH_7TH" }).problem).toMatch(/PUBLIC/);
  });

  it("lands every CMS collection in content/ or public/media/ of the drafts repo only", () => {
    const config = YAML.parse(fs.readFileSync(path.join(ROOT, "public/admin/config.yml"), "utf8")) as {
      backend: { repo: string };
      media_folder: string;
      collections: Array<{ name?: string; folder?: string; files?: Array<{ file: string }> }>;
    };
    expect(config.backend.repo).toBe(DRAFT_REPO_DEFAULT);
    expect(config.media_folder.startsWith("public/media/")).toBe(true);
    for (const collection of config.collections) {
      if (!collection.name) continue;
      if (collection.folder) expect(collection.folder.startsWith("content/")).toBe(true);
      for (const file of collection.files ?? []) {
        expect(file.file.startsWith("content/")).toBe(true);
      }
    }
  });
});

describe("no publish workflow exists in this PR", () => {
  const workflowDir = path.join(ROOT, ".github", "workflows");
  const workflows = fs.existsSync(workflowDir) ? fs.readdirSync(workflowDir) : [];

  it("keeps exactly the CI workflow", () => {
    expect(workflows.sort()).toEqual(["ci.yml"]);
  });

  it("has no deploy/pages/publish job", () => {
    const ci = fs.readFileSync(path.join(workflowDir, "ci.yml"), "utf8");
    for (const forbidden of [
      /deploy-pages/,
      /actions\/deploy-pages/,
      /upload-pages-artifact/,
      /pages:\s*write/,
      /gh-pages/,
      /peaceiris\/actions-gh-pages/,
    ]) {
      expect(forbidden.test(ci)).toBe(false);
    }
    // And the CI permissions stay read-only.
    expect(ci).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("does not mention the drafts repository in any workflow", () => {
    for (const workflow of workflows) {
      const text = fs.readFileSync(path.join(workflowDir, workflow), "utf8");
      expect(text).not.toContain(DRAFT_REPO_DEFAULT);
      expect(text.toLowerCase()).not.toContain("draft");
    }
  });
});

describe("media tooling only writes inside the repository's own tree", () => {
  it("contains no recursive/forced deletion", () => {
    const targets = [
      "scripts/media-import.ts",
      "scripts/media-sync.ts",
      "src/media/import.ts",
      "src/media/tree.ts",
    ];
    for (const target of targets) {
      const text = fs.readFileSync(path.join(ROOT, target), "utf8");
      expect(text).not.toMatch(/rmSync\([^)]*recursive:\s*true/);
      expect(text).not.toMatch(/rm\([^)]*recursive:\s*true/);
      expect(text).not.toMatch(/unlinkSync|fs\.unlink\(/);
      expect(text).not.toMatch(/rmdir/);
    }
  });

  it("refuses writes outside the media root", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/media/import.ts"), "utf8");
    expect(text).toContain("refusing to write outside the media root");
    // Every file write uses the exclusive "wx" flag, so an existing page is
    // never overwritten by a name collision.
    const writes = text.match(/writeFileSync\([^;]+/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const call of writes) expect(call).toContain('flag: "wx"');
  });
});

describe("no secrets, no accidental credentials", () => {
  const secretPatterns = [
    { name: "GitHub classic PAT", re: /\bghp_[A-Za-z0-9]{30,}/ },
    { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
    { name: "GitHub OAuth token", re: /\bgho_[A-Za-z0-9]{30,}/ },
    { name: "GitHub App token", re: /\bghs_[A-Za-z0-9]{30,}/ },
  ];

  it("has no real-looking token anywhere in the tracked tree", () => {
    const hits: string[] = [];
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, "utf8");
      for (const pattern of secretPatterns) {
        if (pattern.re.test(text)) hits.push(`${relative(file)} → ${pattern.name}`);
      }
    }
    // Simulator fixtures use obviously fake 30-ish char strings without the
    // token-shaped entropy; anything matching here would be a real leak.
    expect(hits).toEqual([]);
  });

  it("keeps the verification verdict file out of git", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain("admin-verification.json");
  });

  it("never reads the PAT from argv or from a file in the project", () => {
    const cli = fs.readFileSync(path.join(ROOT, "scripts/admin-verify-github.ts"), "utf8");
    // argv handling must not have a --token option
    expect(cli).not.toMatch(/case "--token"/);
    expect(cli).not.toMatch(/process\.argv\[[^\]]*\]\s*[^)]*token/i);
    // Only stdin / TTY prompt are allowed sources
    expect(cli).toMatch(/--token-stdin/);
    expect(cli).toMatch(/setRawMode/);
    // The only place the raw value is interpolated is the Authorization
    // header of the API probe.
    const interpolations = [...cli.matchAll(/\$\{([^}]*\btoken\b[^}]*)\}/g)].map((match) => match[1] ?? "");
    expect(interpolations).toEqual(["token"]);
    const authLine = cli.split("\n").find((line) => line.includes("Authorization: `token ${token}`"));
    expect(authLine).toBeDefined();
    // No environment variable, file or config may supply it.
    expect(cli).not.toMatch(/process\.env\[[^\]]*token/i);
    expect(cli).not.toMatch(/process\.env\.\w*TOKEN/i);
    expect(cli).not.toMatch(/readFileSync\([^)]*token/i);
  });

  it("only ever prints the token kind, never the token", () => {
    const cli = fs.readFileSync(path.join(ROOT, "scripts/admin-verify-github.ts"), "utf8");
    // Everything written to stdout/stderr must be free of the raw value.
    const logs = [...cli.matchAll(/console\.(?:log|error|warn)\(([\s\S]*?)\);/g)].map((m) => m[1] ?? "");
    const leaks = logs.filter((call) => /\$\{token\}/.test(call) || /\$\{pat\}/.test(call));
    expect(leaks).toEqual([]);
  });
});
