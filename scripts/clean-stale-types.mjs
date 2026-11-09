/**
 * npm predev hook: `next dev` typegen lives in .next/dev/types, while
 * `next build` writes .next/types. After a static-export build the two
 * describe DIFFERENT route sets (the export has no admin/api routes), so
 * running `tsc` while both exist fails with contradictory Route constraints.
 * Starting dev drops the build's copies — dev regenerates its own.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildTypes = path.join(root, ".next", "types");
if (fs.existsSync(buildTypes)) {
  fs.rmSync(buildTypes, { recursive: true, force: true });
}
