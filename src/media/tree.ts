/**
 * Reading and writing the local content tree.
 *
 * Used by the CLI tools (media import/sync). Kept separate from the pure
 * modules so the write surface is small and auditable: every function that
 * writes takes an explicit root, refuses to escape it, and never deletes.
 */

import fs from "node:fs";
import path from "node:path";
import { validateContentTree, type TreeValidation } from "../content/validate";
import type { LessonContent, UnitContent } from "../content/model";

export interface ContentPaths {
  contentRoot: string;
  mediaRoot: string;
}

export function defaultPaths(root = process.cwd()): ContentPaths {
  return { contentRoot: path.join(root, "content"), mediaRoot: path.join(root, "public", "media") };
}

export function readJsonDir<T>(dir: string): Array<{ file: string; value: T }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return { file: entry.name, value: JSON.parse(fs.readFileSync(full, "utf8")) as T };
    });
}

export function readUnits(contentRoot: string): Array<{ file: string; value: UnitContent }> {
  return readJsonDir<UnitContent>(path.join(contentRoot, "units"));
}

export function readLessons(contentRoot: string): Array<{ file: string; value: LessonContent }> {
  return readJsonDir<LessonContent>(path.join(contentRoot, "lessons"));
}

export function readQuizFiles(contentRoot: string): Array<{ file: string; value: unknown }> {
  return readJsonDir<unknown>(path.join(contentRoot, "quizzes"));
}

export function readLesson(contentRoot: string, lessonId: number): { file: string; value: LessonContent } {
  const file = path.join(contentRoot, "lessons", `${lessonId}.json`);
  if (!fs.existsSync(file)) throw new Error(`lesson ${lessonId} not found at content/lessons/${lessonId}.json`);
  return { file: `${lessonId}.json`, value: JSON.parse(fs.readFileSync(file, "utf8")) as LessonContent };
}

/** Writes JSON with a trailing newline, creating the parent directory. */
/**
 * Writes JSON atomically: the payload goes to a sibling temporary file which is
 * then renamed over the target. A crash or a failing write can therefore never
 * leave a truncated or half-encoded record — the target is either the old bytes
 * or the new ones. The temporary file is removed if anything goes wrong.
 */
export function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  } catch (error) {
    // Never let cleanup mask the real failure: on a read-only directory even
    // removing the temporary file is refused, and the caller needs the cause.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the original error is the one that matters */
    }
    throw error;
  }
}

/**
 * Undoes the files a failed commit phase touched: deletes what it created and
 * restores the previous bytes of what it overwrote. A file whose bytes already
 * match is left alone, so this is safe to call after a partially applied batch.
 */
export function rollbackWrites(
  createdFiles: string[],
  overwrittenFiles: Array<{ path: string; previous: Buffer }>,
  createdDirectories: string[] = [],
): { created: number; restored: number } {
  let created = 0;
  let restored = 0;
  for (const target of [...createdFiles].reverse()) {
    try {
      fs.rmSync(target, { force: true });
      created += 1;
    } catch {
      /* reported by the shortfall in the counts */
    }
  }
  for (const file of [...overwrittenFiles].reverse()) {
    try {
      const current = fs.existsSync(file.path) ? fs.readFileSync(file.path) : null;
      if (current !== null && current.equals(file.previous)) continue;
      fs.writeFileSync(file.path, file.previous);
      restored += 1;
    } catch {
      /* as above */
    }
  }
  // Directories the run created are removed too, deepest first, but only if
  // they are empty: leaving `thumbs/` behind would be a visible leftover even
  // though every file in it was undone.
  for (const dir of [...createdDirectories].reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty or already gone — either way, nothing to do */
    }
  }
  return { created, restored };
}

/**
 * `mkdir -p` that records which directories it actually created, so a failed
 * commit can remove exactly those and nothing that was already there.
 */
export function makeDirsTracked(dir: string, created: string[]): void {
  const missing: string[] = [];
  let current = dir;
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const target of [...missing].reverse()) {
    fs.mkdirSync(target);
    created.push(target);
  }
}

export function writeLesson(contentRoot: string, lesson: LessonContent): string {
  const target = path.join(contentRoot, "lessons", `${lesson.id}.json`);
  writeJson(target, lesson);
  return target;
}

/** Re-runs the real content validator against a tree. */
export function validatePaths(paths: ContentPaths, strict = false): TreeValidation {
  const result = validateContentTree(paths.contentRoot, paths.mediaRoot);
  if (strict) {
    return { ...result, errors: [...result.errors, ...result.warnings], warnings: [] };
  }
  return result;
}

export function nowIso(): string {
  return new Date().toISOString();
}
