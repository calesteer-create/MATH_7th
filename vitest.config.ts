import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // tests/static-export.test.ts and tests/server-mode.test.ts each run a
    // real `next build` that shares .next/ and out/ — run files one at a time
    // so those builds can never clobber each other.
    fileParallelism: false,
    // Build-backed suites take minutes, not seconds.
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
});
