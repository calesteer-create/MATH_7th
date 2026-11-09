import path from "node:path";
import { validateContentTree } from "../src/content/validate";

/**
 * Prints a one-line summary of the content tree — handy before publishing.
 *
 *   npm run content:stats
 */
const contentRoot = path.join(process.cwd(), "content");
const mediaRoot = path.join(process.cwd(), "public", "media");
const { stats, errors } = validateContentTree(contentRoot, mediaRoot);

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

console.log("MATH 7TH — content stats");
console.log(`  units:             ${stats.units}`);
console.log(`  lessons:           ${stats.lessons} (${stats.publishedLessons} published, ${stats.draftLessons} drafts)`);
console.log(`  images:            ${stats.images}`);
console.log(`  quizzes:           ${stats.quizzes}`);
console.log(`  media on disk:     ${kib(stats.mediaBytes)}`);
if (errors.length > 0) {
  console.log(`  validation errors: ${errors.length} (run npm run content:validate)`);
}
