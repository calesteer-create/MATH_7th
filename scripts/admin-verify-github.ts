#!/usr/bin/env node
/**
 * `npm run admin:verify-github` — proves (or disproves) that Sveltia CMS can
 * work against the PRIVATE drafts repository.
 *
 * ⚠ This script is evidence gathering, not a claim. Running it successfully
 * means the GitHub side accepts Sveltia's request sequence with a real
 * fine-grained PAT. The CMS itself must still be signed into and saved from in
 * a browser before the integration is considered verified (docs/ADMIN.md §5).
 *
 * Security rules, enforced in code:
 *   - The PAT is read from a hidden TTY prompt, or piped stdin (`--token-stdin`)
 *     for automation. It is never read from argv (argv is world-readable in
 *     `ps`) and never from a committed file.
 *   - The token is never printed, never written to disk, and the workspace file
 *     it lands in contains only a verdict.
 *   - Nothing is written to `main` or to the public repository; the probe uses
 *     a throwaway branch which is deleted in a `finally`.
 *
 * Usage:
 *   npm run admin:verify-github
 *   npm run admin:verify-github -- --repo calesteer-create/MATH_7th-drafts
 *   echo "$PAT" | npm run admin:verify-github -- --token-stdin
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execSync } from "node:child_process";
import {
  GithubClient,
  GithubError,
  describeScopes,
  listBranches,
  type RepoInfo,
} from "../src/github/client";
import {
  PROBE_FILE_DEFAULT,
  SVELTIA_CMS_VERSION,
  cleanupProbeBranch,
  runSveltiaTrace,
  type TraceReport,
} from "../src/github/sveltia-traces";
import { DRAFT_BRANCH, PUBLIC_REPO, classifyRepo, normalizeRepo, resolveDraftRepo } from "../src/media/repo-guard";

interface CliOptions {
  repo: string;
  branch: string;
  tokenStdin: boolean;
  json: string | null;
  keepBranch: boolean;
  yes: boolean;
}

const REPORT_PATH = path.join(process.cwd(), "admin-verification.json");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    repo: "",
    branch: "",
    tokenStdin: false,
    json: null,
    keepBranch: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo":
        options.repo = argv[++i] ?? "";
        break;
      case "--branch":
        options.branch = argv[++i] ?? "";
        break;
      case "--token-stdin":
        options.tokenStdin = true;
        break;
      case "--json":
        options.json = argv[++i] ?? REPORT_PATH;
        break;
      case "--keep-branch":
        options.keepBranch = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith("--")) fail(`unknown option ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`admin:verify-github — probe Sveltia CMS compatibility with a private GitHub repo

  --repo owner/name     drafts repository (default: $DRAFT_REPO or ${"calesteer-create/MATH_7th-drafts"})
  --branch name         scratch branch to use (default: admin-verification-<timestamp>)
  --token-stdin         read the PAT from stdin instead of prompting (for CI/automation)
  --json PATH           write the verdict JSON here (default: ./admin-verification.json)
  --keep-branch         do not delete the scratch branch (for debugging; prints the name)
  --yes                 skip the interactive confirmation
  -h, --help            this text

The token is never stored or printed. Use a fine-grained PAT limited to the
drafts repository with Contents: Read and write (Metadata: Read is automatic).
`);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(2);
}

/** Hidden TTY prompt; falls back to stdin when there is no terminal. */
async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "no interactive terminal available. Pipe the token instead:\n" +
        "  read -rs PAT && printf '%s' \"$PAT\" | npm run admin:verify-github -- --token-stdin",
    );
  }
  process.stdout.write(
    "Paste the fine-grained PAT for the drafts repo (input is hidden, nothing is saved): ",
  );
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  let token = "";
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);
        if (char === "\u0003") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve();
          return;
        }
        if (byte === 127 || byte === 8) {
          token = token.slice(0, -1);
          continue;
        }
        token += char;
      }
    };
    stdin.on("data", onData);
  });
  stdin.setRawMode?.(wasRaw ?? false);
  return token.trim();
}

async function readStdinToken(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * A PAT that reaches this script must never appear in shell history or on
 * disk; both of those are outside our control, so the best we can do is refuse
 * obvious mistakes (empty token, whitespace, non-PAT prefixes).
 */
function sanityCheckToken(token: string): string | null {
  if (token.length === 0) return "the token is empty";
  if (/\s/.test(token)) return "the token contains whitespace — it was probably pasted with a line break";
  if (token.length < 20) return "the token looks too short to be a GitHub PAT";
  const known = ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_"];
  if (!known.some((prefix) => token.startsWith(prefix))) {
    return "the token does not start with a known GitHub prefix (ghp_ / github_pat_ / …); copy it again";
  }
  return null;
}

function currentOrigin(): string | null {
  try {
    return execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function scratchBranch(): string {
  // Deterministic prefix so leftovers are easy to find and clean up.
  return `admin-verification-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

interface Verdict {
  cms: string;
  verified: boolean;
  repo: string;
  private: boolean | null;
  token: { kind: string; scopes: string; permissions: string };
  steps: Array<{ id: string; action: string; ok: boolean; note: string; error?: string }>;
  findings: string[];
  cleanup: string;
  blockedReason?: string;
  at: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resolution = resolveDraftRepo({ DRAFT_REPO: options.repo || process.env["DRAFT_REPO"] });
  if (resolution.problem) fail(resolution.problem);
  const [owner, repoName] = resolution.repo.split("/") as [string, string];

  const origin = currentOrigin();
  if (origin && origin.toLowerCase().includes(PUBLIC_REPO.toLowerCase())) {
    // Not fatal in itself, but say it loudly: this checkout IS the public repo.
    console.log(
      `i this checkout's origin is ${PUBLIC_REPO} (the public site). Draft probes go to ${resolution.repo} instead.\n`,
    );
  }

  const token = options.tokenStdin ? await readStdinToken() : await promptToken();
  const problem = sanityCheckToken(token);
  if (problem) fail(problem);

  const branch = options.branch || scratchBranch();
  if (branch === DRAFT_BRANCH || branch.toLowerCase() === "main") {
    fail("the probe never writes to main; pass --branch with a scratch name (default is generated)");
  }

  console.log("MATH 7TH — Sveltia CMS private-repository verification");
  console.log(`  cms:    @sveltia/cms@${SVELTIA_CMS_VERSION}`);
  console.log(`  repo:   ${resolution.repo}${classifyRepo(resolution.repo) === "draft" ? "" : " (non-default name)"}`);
  console.log(`  branch: ${branch} (scratch; never ${DRAFT_BRANCH})`);
  console.log(`  token:  not logged, not saved\n`);

  const client = new GithubClient({ token });
  const findings: string[] = [];
  let repoInfo: RepoInfo | null = null;
  let tokenKind = "unknown";
  let scopes = "unknown";

  try {
    repoInfo = await client.rest<RepoInfo>(client.repoPath(owner, repoName));
  } catch (error) {
    const detail =
      error instanceof GithubError
        ? `${error.kind} (${error.status}): ${error.advice}`
        : (error as Error).message;
    console.error(`✗ cannot read ${resolution.repo} — ${detail}`);
    console.error(
      "\n  Nothing was written. Common causes:\n" +
        "   • the token's resource owner is a different account than the repository owner\n" +
        "   • the repository is not selected in the token's repository list\n" +
        "   • the token expired or was revoked\n",
    );
    process.exit(1);
  }

  // Classic tokens report scopes in a header; fine-grained ones do not. The
  // classification below is informational — permissions are what matter.
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, "User-Agent": "math-7th-admin-probe" },
    });
    scopes = describeScopes(response.headers.get("x-oauth-scopes"));
    tokenKind = response.headers.get("x-oauth-scopes") === null ? "fine-grained" : "classic";
  } catch {
    scopes = "unavailable";
  }

  console.log(`✓ ${repoInfo.full_name} is ${repoInfo.private ? "PRIVATE" : "PUBLIC"}`);
  if (!repoInfo.private) {
    findings.push(
      "⚠ The repository is public. That does NOT prove private-repository support (requirement 6).",
    );
  }
  console.log(`  default branch: ${repoInfo.default_branch}`);
  console.log(`  token kind:     ${tokenKind} (scopes: ${scopes})`);
  const perms = repoInfo.permissions;
  console.log(
    `  push/maintain/admin: ${String(perms?.push ?? false)} / ${String(perms?.maintain ?? false)} / ${String(perms?.admin ?? false)}`,
  );

  if (!options.yes) {
    const proceed = await confirm(
      `\nThis will create a temporary branch "${branch}", commit one probe file (${PROBE_FILE_DEFAULT}), ` +
        `then delete the branch. Nothing is written to ${repoInfo.default_branch} or to ${PUBLIC_REPO}.\n` +
        "Continue? [y/N] ",
    );
    if (!proceed) {
      console.log("Aborted. Nothing was changed.");
      process.exit(0);
    }
  }

  const report: TraceReport = await runTraceAndCleanup(token, owner, repoName, branch, options, repoInfo);

  const verdict: Verdict = {
    cms: `@sveltia/cms@${SVELTIA_CMS_VERSION}`,
    verified: report.ok && repoInfo.private === true,
    repo: repoInfo.full_name,
    private: repoInfo.private,
    token: { kind: tokenKind, scopes, permissions: `push=${String(perms?.push ?? false)}` },
    steps: report.steps.map((step) => ({
      id: step.step.id,
      action: step.step.action,
      ok: step.ok,
      note: step.note,
      ...(step.error ? { error: `${step.error.kind}: ${step.error.message}` } : {}),
    })),
    findings: [...findings, ...report.findings],
    cleanup: report.cleanup ?? "not attempted",
    at: new Date().toISOString(),
    ...(report.blockedReason ? { blockedReason: report.blockedReason } : {}),
  };

  printReport(verdict);
  if (options.json !== "skip") {
    const target = options.json ?? REPORT_PATH;
    fs.writeFileSync(target, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    console.log(`\n  verdict written to ${path.relative(process.cwd(), target)} (contains no token)`);
  }
  process.exit(verdict.verified ? 0 : 1);
}

async function runTraceAndCleanup(
  token: string,
  owner: string,
  repoName: string,
  branch: string,
  options: CliOptions,
  repoInfo: RepoInfo,
): Promise<TraceReport & { cleanup?: string }> {
  const client = new GithubClient({ token });
  let report: TraceReport & { cleanup?: string };
  try {
    report = await runSveltiaTrace(client, {
      owner,
      repo: repoName,
      branch,
      onStep: (result) => {
        const mark = result.ok ? "✓" : "✗";
        console.log(`  ${mark} ${result.step.action} — ${result.note}`);
        if (result.error) console.log(`      ${result.error.advice}`);
      },
    });
  } finally {
    if (options.keepBranch) {
      const branches = await listBranches(client, owner, repoName).catch(() => [] as string[]);
      const note = branches.includes(branch)
        ? `kept scratch branch ${branch} (--keep-branch). Delete it with: gh api -X DELETE repos/${owner}/${repoName}/git/refs/heads/${branch}`
        : `nothing to clean up (branch ${branch} was not created)`;
      console.log(`\n  ${note}`);
      (report ??= { ok: false, steps: [], findings: [] }).cleanup = note;
    } else {
      const cleanup = await cleanupProbeBranch(client, owner, repoName, branch, repoInfo.default_branch);
      console.log(`\n  ${cleanup.ok ? "✓" : "✗"} ${cleanup.note}`);
      (report ??= { ok: false, steps: [], findings: [] }).cleanup = cleanup.note;
      if (!cleanup.ok) {
        console.error(
          `\n  ⚠ Could not remove the scratch branch. Delete it manually before re-running:\n` +
            `    gh api -X DELETE repos/${owner}/${repoName}/git/refs/heads/${branch}\n`,
        );
      }
    }
  }
  return report;
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function printReport(verdict: Verdict): void {
  console.log("\n─────────────────────────────────────────────");
  console.log(verdict.verified ? "RESULT: PASS (private-repo GitHub side)" : "RESULT: NOT VERIFIED");
  console.log("─────────────────────────────────────────────");
  for (const finding of verdict.findings) console.log(`  • ${finding}`);
  if (verdict.blockedReason) console.log(`  ✗ blocked: ${verdict.blockedReason}`);
  console.log(`  cleanup: ${verdict.cleanup}`);
  if (verdict.verified) {
    console.log(
      "\nNext step (still required before calling Sveltia verified): open /admin/ in a browser,\n" +
        "sign in with the same token, open one unit, save it, and confirm the commit appears\n" +
        "in the drafts repository. Only then update ADMIN_STATUS.verifiedAgainstPrivateRepo.\n",
    );
  } else {
    console.log(
      "\nThe CMS integration stays marked EXPERIMENTAL. Fix the failing steps above and re-run.\n",
    );
  }
}

void main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
