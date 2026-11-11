/**
 * Requirement 5/10: nothing in PR 5 may write to the public repository or the
 * public branch, and no draft edit may trigger an automatic publish.
 *
 * These checks are structural on purpose — they assert on the repository
 * itself (config, workflows, scripts, generated CMS config), so a future edit
 * that quietly reintroduces a public write path fails CI instead of shipping.
 */
import fs from "node:fs";
import os from "node:os";
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
      collections: Array<{
        name?: string;
        folder?: string;
        files?: Array<{ file: string }>;
        media_folder?: string;
      }>;
    };
    expect(config.backend.repo).toBe(DRAFT_REPO_DEFAULT);
    // The root folder is `public/media` (templateless, see the G1 fix); a
    // collection may narrow it further, but never outside `public/media/`.
    const withinMediaRoot = (value: string) =>
      value.replace(/^\/+/, "").startsWith("public/media/");
    expect(config.media_folder === "public/media" || withinMediaRoot(config.media_folder)).toBe(true);
    for (const collection of config.collections) {
      if (!collection.name) continue;
      if (collection.folder) expect(collection.folder.startsWith("content/")).toBe(true);
      if (collection.media_folder) expect(withinMediaRoot(collection.media_folder)).toBe(true);
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
      // Empty-directory cleanup is allowed only under the repository's own
      // tree; what must never appear is a directory removal by path string.
      expect(text).not.toMatch(/\brmdir\b(?!Sync)/);
    }
  });

  it("deletion helpers are confined to an explicit, caller-supplied root", async () => {
    // The textual check above cannot see behaviour: `rmdirSync(path)` looks
    // identical whether the path is contained or not. These assertions call the
    // API directly, so a future helper that deletes whatever it is given — or
    // one that silently ignores a refused path — fails here.
    const { rollbackWrites } = await import("@/media/tree");
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "no-public-write-"));
    try {
      const allowed = path.join(sandbox, "public", "media");
      const victim = path.join(sandbox, "outside", "victim");
      fs.mkdirSync(path.join(allowed, "lessons", "1"), { recursive: true });
      fs.mkdirSync(victim, { recursive: true });
      const fileVictim = path.join(sandbox, "outside", "keep.txt");
      fs.writeFileSync(fileVictim, "must survive");

      const targets = [
        victim, // absolute, outside the allowed root
        path.join(sandbox, "outside", "not-there", "..", "victim"), // traversal
        "/tmp", // unrelated absolute path
        process.cwd(), // the repository root
      ];
      // Deleting a *file* and restoring over one is refused on the same rule.
      for (const target of targets) {
        const dirResult = rollbackWrites([], [], [target], [allowed]);
        expect(dirResult.skipped, target).toBe(1);
        expect(dirResult.failures.length, target).toBeGreaterThan(0);

        const fileResult = rollbackWrites([target], [], [], [allowed]);
        expect(fileResult.skipped, target).toBe(1);
        expect(fileResult.failures.length, target).toBeGreaterThan(0);

        const restoreResult = rollbackWrites([], [{ path: target, previous: Buffer.from("x") }], [], [allowed]);
        expect(restoreResult.skipped, target).toBe(1);
      }

      // Nothing outside the allowed root was deleted or overwritten.
      expect(fs.existsSync(victim)).toBe(true);
      expect(fs.readFileSync(fileVictim, "utf8")).toBe("must survive");
      expect(fs.existsSync(path.join(process.cwd(), "package.json"))).toBe(true);
      expect(fs.existsSync("/tmp")).toBe(true);

      // Sanity: without any allowed root nothing is deletable at all.
      const noRoots = rollbackWrites([targets[0]!], [], [targets[0]!]);
      expect(noRoots.skipped).toBe(2);
      expect(fs.existsSync(victim)).toBe(true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
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

describe("visibility is checked, not assumed (fix 2)", () => {
  it("checkWritableRepo requires GitHub to say private === true", async () => {
    const { checkWritableRepo } = await import("@/media/repo-guard");
    const name = "calesteer-create/notes-and-plans";
    // Generator destination mode: only the agreed repo is ever writable, so a
    // foreign-but-probably-private name is refused regardless of visibility.
    expect(checkWritableRepo(name, { full_name: name, private: true }).writable).toBe(false);
    // Verified (CLI) mode does accept it — but only with live proof of privacy.
    expect(
      checkWritableRepo(name, { full_name: name, private: true }, { destination: "verified" })
        .writable,
    ).toBe(true);
    expect(checkWritableRepo(DRAFT_REPO_DEFAULT, { full_name: DRAFT_REPO_DEFAULT, private: true }).writable).toBe(true);
    for (const value of [false, null, 0, "true", undefined] as unknown[]) {
      const verdict = checkWritableRepo(
        name,
        { full_name: name, private: value as boolean | null },
        { destination: "verified" },
      );
      expect(verdict.writable).toBe(false);
      expect(verdict.problem).toMatch(/PRIVATE|private=/);
    }
  });

  it("the CMS config builder refuses the public repository instead of relying on callers", async () => {
    const { buildAdminConfig } = await import("@/media/cms-config");
    expect(() => buildAdminConfig({ repo: PUBLIC_REPO })).toThrow(/PUBLIC repository/);
    expect(() => buildAdminConfig({ repo: "Calesteer-Create/MATH_7TH" })).toThrow(/PUBLIC repository/);
    expect(() => buildAdminConfig({ repo: DRAFT_REPO_DEFAULT })).not.toThrow();
  });

  it("the committed config and the panel never name a public drafts target", () => {
    const config = fs.readFileSync(path.join(ROOT, "public/admin/config.yml"), "utf8");
    const backendRepo = /repo:\s*(\S+)/.exec(config)?.[1]?.replace(/"/g, "");
    expect(backendRepo).toBe(DRAFT_REPO_DEFAULT);
    const html = fs.readFileSync(path.join(ROOT, "public/admin/index.html"), "utf8");
    expect(html).not.toMatch(/repo:\s*calesteer-create\/MATH_7th\b(?!-drafts)/);
    expect(html).toMatch(/PRIVATE|خاص/i);
  });
});
