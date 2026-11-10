#!/usr/bin/env node
/**
 * `npm run admin:config` — write public/admin/config.yml from src/media/cms-config.ts.
 *
 *   npm run admin:config          # (re)generate the file
 *   npm run admin:config -- --check   # exit 1 if the committed file is stale
 *
 * Keeping the YAML generated means the CMS config can never drift from the
 * content model or from the repository guard: if the drafts repository is
 * renamed, one env var and one regeneration updates everything.
 */

import fs from "node:fs";
import path from "node:path";
import { ADMIN_CONFIG_PATH, currentAdminOptions, renderAdminConfig } from "../src/media/cms-config";
import { DRAFT_REPO_ENV } from "../src/media/repo-guard";

function main(): void {
  const check = process.argv.includes("--check");
  let options;
  try {
    options = currentAdminOptions(process.env);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(2);
  }

  const target = path.join(process.cwd(), ADMIN_CONFIG_PATH);
  const generated = renderAdminConfig(options);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

  if (check) {
    if (existing === generated) {
      console.log(`✓ admin config is up to date (${ADMIN_CONFIG_PATH}, backend ${options.repo})`);
      return;
    }
    console.error(
      `✗ ${ADMIN_CONFIG_PATH} is stale. Run \`npm run admin:config\` and commit the result.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (existing === generated) {
    console.log(`✓ admin config already up to date (${ADMIN_CONFIG_PATH}, backend ${options.repo})`);
    return;
  }
  fs.writeFileSync(target, generated, "utf8");
  console.log(
    `✓ wrote ${ADMIN_CONFIG_PATH}\n` +
      `  backend: github → ${options.repo} (${options.branch})\n` +
      `  status:  EXPERIMENTAL — see docs/ADMIN.md\n` +
      `  override the repository with ${DRAFT_REPO_ENV}=owner/name`,
  );
}

main();
