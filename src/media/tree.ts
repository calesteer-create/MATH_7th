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
export function writeJson(root: string, target: string, value: unknown): void {
  const safeTarget = resolveInside(root, target);
  const directory = path.dirname(safeTarget);
  // `recursive: true` would happily create directories through a symlink, so
  // the parent is verified *after* creation as well as before it.
  fs.mkdirSync(directory, { recursive: true });
  resolveInside(root, directory);

  const temporary = `${safeTarget}.tmp-${process.pid}`;
  // O_NOFOLLOW: the last component must not be — nor become — a symlink.
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  try {
    const fd = fs.openSync(temporary, flags, 0o644);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    // Verified again immediately before the rename, which follows a symlinked
    // directory component and would otherwise publish outside the root.
    resolveInside(root, safeTarget);
    fs.renameSync(temporary, safeTarget);
  } catch (error) {
    // Never let cleanup mask the real failure: on a read-only directory even
    // removing the temporary file is refused, and the caller needs the cause.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* as above */
    }
    throw error;
  }
}

/**
 * A path that is proven to stay inside a permitted root and to contain no
 * symbolic link anywhere below it.
 *
 * Why not just `realpath` or `startsWith`: both are checks, and a check is
 * separated from the write by a window in which the path can change. Worse,
 * neither survives contact with the filesystem — `rename(2)` and `open(2)`
 * follow a symlinked *directory* component, so `mediaRoot/thumbs -> /etc` is
 * traversed by the kernel even though the string starts with `mediaRoot`.
 *
 * So this type means: every component below the root was verified with
 * `lstat` to be a real directory, or (for the last component) the path does not
 * exist yet. Anything that exists as a symlink — directory or file — or as a
 * non-directory where a directory is required, is refused before any write.
 */
export type SafePath = string & { readonly __safePath: unique symbol };

/** Thrown when a path is outside its root or reaches through a symlink. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolves `target` and proves it is inside `root` without traversing any
 * symbolic link. Returns the real path string (absolute, `..` free) or throws
 * `UnsafePathError`.
 *
 * `root` itself is normalised and is allowed to exist; it is not required to be
 * a symlink-free name, because the operator chooses it (e.g. macOS `/tmp`).
 * Everything *below* it must be real.
 */
export function resolveInside(root: string, target: string): SafePath {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);

  // 1. Lexical containment: cheap, and it makes the component walk finite.
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    throw new UnsafePathError(`${absoluteTarget} is outside ${absoluteRoot}`);
  }

  // 2. The root must be a real directory (or absent, in which case there is
  //    nothing to write into yet).
  const rootStat = lstatOrNull(absoluteRoot);
  if (rootStat !== null && rootStat.isSymbolicLink()) {
    throw new UnsafePathError(`root ${absoluteRoot} is a symbolic link`);
  }
  if (rootStat !== null && !rootStat.isDirectory()) {
    throw new UnsafePathError(`root ${absoluteRoot} is not a directory`);
  }

  // 3. Walk every component below the root. A symlink anywhere is refused, and
  //    the first non-existent component ends the walk: nothing below it exists,
  //    so nothing below it can be a symlink.
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = absoluteRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null) break;
    if (stat.isSymbolicLink()) {
      throw new UnsafePathError(`${current} is a symbolic link`);
    }
    const isLast = index === parts.length - 1;
    if (!isLast && !stat.isDirectory()) {
      throw new UnsafePathError(`${current} is not a directory`);
    }
  }

  return absoluteTarget as SafePath;
}

/** Throws unless `target` is safe to write to under `root`. */
export function assertSafePath(root: string, target: string): SafePath {
  return resolveInside(root, target);
}

/**
 * Undoes the files a failed commit phase touched: deletes what it created and
 * restores the previous bytes of what it overwrote. A file whose bytes already
 * match is left alone, so this is safe to call after a partially applied batch.
 *
 * Deletion is confined to `allowedRoots`: an entry that resolves outside every
 * one of them is **refused**, never removed, and reported as a failure. The
 * caller records the paths, but a rollback must not be a way to reach the rest
 * of the filesystem if a path is ever wrong or hostile.
 *
 * Failures are returned, never swallowed: the caller has to be able to say
 * whether the tree really is unchanged instead of assuming it.
 */
export function rollbackWrites(
  createdFiles: string[],
  overwrittenFiles: Array<{ path: string; previous: Buffer }>,
  createdDirectories: string[] = [],
  allowedRoots: string[] = [],
): { created: number; restored: number; skipped: number; failures: string[] } {
  let created = 0;
  let restored = 0;
  let skipped = 0;
  const failures: string[] = [];
  /**
   * A target is permitted only if it lies inside one of the allowed roots *and*
   * reaches it without traversing a symlink. `resolveInside` is the same guard
   * the write path uses, so deletion cannot be looser than creation.
   */
  const permitted = (target: string): { ok: true } | { ok: false; reason: string } => {
    if (allowedRoots.length === 0) return { ok: false, reason: "no writable root was declared" };
    let reason = "outside the writable tree";
    for (const root of allowedRoots) {
      try {
        resolveInside(root, target);
        return { ok: true };
      } catch (error) {
        if (error instanceof UnsafePathError) reason = error.message;
      }
    }
    return { ok: false, reason };
  };

  for (const target of [...createdFiles].reverse()) {
    const check = permitted(target);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to delete ${target}: ${check.reason}`);
      continue;
    }
    try {
      fs.rmSync(target, { force: true });
      created += 1;
    } catch (error) {
      failures.push(`could not delete ${target}: ${(error as Error).message}`);
    }
  }
  for (const file of [...overwrittenFiles].reverse()) {
    const check = permitted(file.path);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to restore ${file.path}: ${check.reason}`);
      continue;
    }
    try {
      const current = fs.existsSync(file.path) ? fs.readFileSync(file.path) : null;
      if (current !== null && current.equals(file.previous)) continue;
      fs.writeFileSync(file.path, file.previous);
      restored += 1;
    } catch (error) {
      failures.push(`could not restore ${file.path}: ${(error as Error).message}`);
    }
  }
  // Directories the run created are removed too, deepest first, but only if
  // they are empty: leaving `thumbs/` behind would be a visible leftover even
  // though every file in it was undone.
  for (const dir of [...createdDirectories].reverse()) {
    const check = permitted(dir);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to remove ${dir}: ${check.reason}`);
      continue;
    }
    try {
      fs.rmdirSync(dir); // empty directories only; never recursive
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // "Not empty" or "already gone" is a successful no-op, not a failure.
      if (code !== "ENOTEMPTY" && code !== "ENOENT") {
        failures.push(`could not remove ${dir}: ${(error as Error).message}`);
      }
    }
  }
  return { created, restored, skipped, failures };
}

/**
 * The lines `media:sync` prints after a failed commit phase.
 *
 * Kept here, not inline, so the "tree is unchanged" claim can be tested against
 * every possible rollback outcome: it is only allowed when the rollback
 * reported no failures at all. A rollback that could not finish must say so and
 * keep the original cause visible — hiding it would describe a tree that is not
 * the one on disk.
 */
export function formatRollbackReport(
  cause: unknown,
  rolled: { created: number; restored: number; skipped: number; failures: string[] },
): { lines: string[]; failureLines: string[]; complete: boolean } {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const lines = [
    `✗ writing failed: ${causeMessage}`,
    `rollback: ${rolled.created} new file(s) deleted, ${rolled.restored} restored, ` +
      `${rolled.skipped} refused (outside the tree)`,
  ];
  const complete = rolled.failures.length === 0;
  if (complete) {
    lines.push("the tree is unchanged.");
    return { lines, failureLines: [], complete };
  }
  const failureLines = rolled.failures.map((failure) => `✗ rollback: ${failure}`);
  lines.push(...failureLines);
  lines.push(
    "⚠ ROLLBACK INCOMPLETE — the tree may differ from how it was found; " +
      "inspect the files listed above before re-running.",
  );
  return { lines, failureLines, complete };
}

/**
 * `mkdir -p` that records which directories it actually created, so a failed
 * commit can remove exactly those and nothing that was already there.
 */
export function makeDirsTracked(root: string, dir: string, created: string[]): void {
  // The whole chain is validated first: a symlinked component below the root is
  // refused here rather than allowed to redirect every directory created below.
  resolveInside(root, dir);
  const missing: string[] = [];
  let current = path.resolve(dir);
  const absoluteRoot = path.resolve(root);
  while (current !== absoluteRoot && lstatOrNull(current) === null) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const target of [...missing].reverse()) {
    fs.mkdirSync(target);
    created.push(target);
  }
  resolveInside(root, dir);
}

export function writeLesson(contentRoot: string, lesson: LessonContent): string {
  const target = path.join(contentRoot, "lessons", `${lesson.id}.json`);
  writeJson(contentRoot, target, lesson);
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
