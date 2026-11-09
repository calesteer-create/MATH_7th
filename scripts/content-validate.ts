import path from "node:path";
import { validateContentTree, type ContentIssue } from "../src/content/validate";

/**
 * Validates the content tree and the media folder.
 *
 *   npm run content:validate                # content/ + public/media
 *   npm run content:validate -- --strict    # warnings count as failures
 *   npm run content:validate -- --content PATH --media PATH
 *
 * Used by CI and by the publish pipeline. Exit code 1 on any error (or on
 * warnings with --strict).
 */
function parseArgs(argv: string[]) {
  const options = { strict: false, content: undefined as string | undefined, media: undefined as string | undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--content") options.content = argv[i + 1];
    else if (arg === "--media") options.media = argv[i + 1];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: content-validate [--strict] [--content PATH] [--media PATH]");
      process.exit(0);
    }
  }
  return options;
}

function printIssues(title: string, issues: ContentIssue[]): void {
  if (issues.length === 0) return;
  console.log(`\n${title} (${issues.length})`);
  for (const issue of issues) {
    console.log(`  [${issue.code}] ${issue.path} — ${issue.message}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const contentRoot = path.resolve(options.content ?? path.join(process.cwd(), "content"));
const mediaRoot = path.resolve(options.media ?? path.join(process.cwd(), "public", "media"));

const { errors, warnings, stats } = validateContentTree(contentRoot, mediaRoot);

console.log("MATH 7TH — content validation");
console.log(`  content: ${contentRoot}`);
console.log(`  media:   ${mediaRoot}`);
console.log(
  `  stats:   ${stats.units} units · ${stats.lessons} lessons (${stats.publishedLessons} published, ${stats.draftLessons} drafts) · ${stats.images} images · ${stats.quizzes} quizzes · ${stats.mediaBytes} bytes of media`,
);
printIssues("errors", errors);
printIssues("warnings", warnings);

const failed = errors.length > 0 || (options.strict && warnings.length > 0);
console.log(failed ? "\n✗ content validation failed" : warnings.length > 0 ? "\n✓ content valid (with warnings)" : "\n✓ content valid");
process.exit(failed ? 1 : 0);
