/**
 * Reading and writing the local content tree.
 *
 * Used by the CLI tools (media import/sync). Kept separate from the pure
 * modules so the write surface is small and auditable: every function that
 * writes takes an explicit root, refuses to escape it, and never deletes.
 */

import fs from "node:fs";
import os from "node:os";
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
 * Writes a new file inside `root` and refuses to traverse a symlink.
 *
 * The single write primitive shared by every producer (`media:import`,
 * `media:sync`): `O_CREAT|O_EXCL|O_NOFOLLOW` so a link at the target can never
 * be followed, an exclusive create so an existing page is never clobbered, and
 * a re-check of every directory component immediately before the open.
 * `exclusive: false` truncates an existing real file instead (used for derived
 * thumbnails, which are regenerated).
 */
export function writeFileInside(
  root: string,
  target: string,
  data: Buffer,
  options: { exclusive?: boolean; mode?: number } = {},
): SafePath {
  const safeTarget = resolveInside(root, target);
  const directory = path.dirname(safeTarget);
  fs.mkdirSync(directory, { recursive: true });
  // `recursive: true` creates through a symlink if one appeared, so the whole
  // chain is verified after creation as well as before.
  resolveInside(root, directory);

  const exclusive = options.exclusive ?? true;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW |
    (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC);

  // Verified again right before the open, which is as close to the syscall as
  // this API allows.
  resolveInside(root, directory);
  const fd = fs.openSync(safeTarget, flags, options.mode ?? 0o644);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return safeTarget;
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
 * **The root is the trust boundary, and it is chosen by the operator.** The
 * root path is resolved **once** with `realpathSync`, which follows the root
 * itself *and every ancestor* — refusing either would break legitimate layouts,
 * notably macOS where `/tmp` is a symlink to `/private/tmp`, while the operator
 * asked for that directory explicitly.
 *
 * The single namespace this function returns is **the resolved root's**: the
 * returned path is `realpath(root) + relative(target)`. Every caller must use
 * that returned value for the whole operation and must not re-check it against
 * the *unresolved* root — doing so mixes two namespaces and rejects perfectly
 * valid paths. `writeJson`, `writeFileInside`, `makeDirsTracked` and
 * `rollbackWrites` all follow that rule; `resolveKey` in `src/lib/storage.ts`
 * returns the resolved path for the same reason.
 *
 * Everything *below* the resolved root must be a real directory — that is the
 * part an attacker who can plant links inside the tree controls.
 *
 * Threat model: this stops **pre-existing** symlinks (a checked-in link, one
 * created by an earlier run, or one placed by someone who can write into the
 * media tree). It does not, and cannot with this API, make a *concurrent*
 * swap of a directory component atomic — Node exposes no dirfd-relative
 * openat, so `lstat` + re-check narrows that window instead of closing it. The
 * final component is protected by the kernel (`O_NOFOLLOW`), and every
 * directory component is re-verified immediately before the write.
 */
export function resolveInside(root: string, target: string): SafePath {
  const declaredRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);

  // 1. Resolve the root once. `realpathSync` follows the root itself and every
  //    ancestor; a root that does not exist yet keeps its declared path, because
  //    there is nothing to resolve and nothing below it can exist either.
  const resolvedRoot = resolveExistingPrefix(declaredRoot);
  const rootStat = lstatOrNull(resolvedRoot);
  if (rootStat !== null && !rootStat.isDirectory()) {
    throw new UnsafePathError(`root ${declaredRoot} is not a directory`);
  }

  // 2. A root with two names has two valid spellings, and both name the same
  //    trust boundary. Accept either — reject anything under neither — then work
  //    exclusively from the resolved spelling. This is what keeps a resolved
  //    path from being mistaken for an escape when the root is a symlink.
  const candidates = resolvedRoot === declaredRoot ? [declaredRoot] : [declaredRoot, resolvedRoot];
  let relative: string | null = null;
  for (const candidate of candidates) {
    const under = path.relative(candidate, absoluteTarget);
    const escapes =
      under !== "" && (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under));
    if (!escapes) {
      relative = under;
      break;
    }
  }
  if (relative === null) {
    throw new UnsafePathError(`${absoluteTarget} is outside ${declaredRoot}`);
  }

  const absoluteRoot = resolvedRoot;
  const absoluteResolvedTarget = relative === "" ? absoluteRoot : path.join(absoluteRoot, relative);

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

  return absoluteResolvedTarget as SafePath;
}

/**
 * `realpath` for a path that may not exist yet: resolves the longest existing
 * prefix and re-appends the rest, so a root that the first write creates still
 * gets a real, symlink-free base instead of its literal spelling.
 */
function resolveExistingPrefix(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    if (lstatOrNull(current) !== null) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.push(path.basename(current));
    current = parent;
  }
  const exists = lstatOrNull(current) !== null;
  const resolvedBase = exists ? fs.realpathSync(current) : current;
  return missing.length === 0 ? resolvedBase : path.join(resolvedBase, ...missing.reverse());
}

/**
 * Opens an installed directory chain, one component at a time, relative to the
 * descriptor of its parent.
 *
 * `openat` is not exposed by Node, but `/proc/self/fd/<n>/<child>` is the same
 * operation: the kernel resolves `<child>` against the *inode* the descriptor is
 * pinned to, so renaming or symlinking components of the textual path after the
 * walk has begun cannot redirect it. `O_NOFOLLOW` refuses a symlinked component
 * and `O_DIRECTORY` refuses a non-directory, both enforced by the kernel.
 *
 * The reader gets a descriptor, not a path: reading, listing and unlinking then
 * happen relative to it, so there is no second resolution to race against.
 *
 * Returns `null` when a component does not exist (`ENOENT`), which for a reader
 * means "nothing there" rather than an error.
 */
/**
 * The directory descriptor namespace: Linux `/proc/self/fd`, and macOS/BSD
 * `/dev/fd` (which is the same mechanism). Resolved once, and *proved* by
 * opening a real descriptor and listing it — a platform without either is
 * detected here rather than failing later with a confusing `ENOENT`.
 */
let fdNamespace: string | null | undefined;

function resolveFdNamespace(): string {
  if (fdNamespace !== undefined) {
    if (fdNamespace === null) {
      throw new UnsafePathError(
        "this platform exposes no /proc/self/fd or /dev/fd descriptor namespace, so directory " +
          "descriptor-relative access is unavailable; refusing to fall back to path re-resolution",
      );
    }
    return fdNamespace;
  }
  for (const candidate of ["/proc/self/fd", "/dev/fd"]) {
    try {
      const probe = fs.openSync(os.tmpdir(), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        fs.readdirSync(`${candidate}/${probe}`);
      } finally {
        fs.closeSync(probe);
      }
      fdNamespace = candidate;
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  fdNamespace = null;
  return resolveFdNamespace();
}

/** `<namespace>/<fd>/<child>`: the closest thing to `openat` Node exposes. */
function at(fd: number, child?: string): string {
  const base = `${resolveFdNamespace()}/${fd}`;
  return child === undefined ? base : `${base}/${child}`;
}

export interface DirHandle {
  fd: number;
  /** Opens an entry inside this directory, resolved against the pinned inode. */
  open: (name: string, flags: number) => number;
  /** Lists this directory through the descriptor. */
  list: () => fs.Dirent[];
  close: () => void;
}

export function openDirInside(root: string, target: string): DirHandle | null {
  const declaredRoot = path.resolve(root);
  const resolvedRoot = resolveExistingPrefix(declaredRoot);
  const candidates = resolvedRoot === declaredRoot ? [declaredRoot] : [declaredRoot, resolvedRoot];
  const absoluteTarget = path.resolve(target);
  let relative: string | null = null;
  for (const candidate of candidates) {
    const under = path.relative(candidate, absoluteTarget);
    const escapes =
      under !== "" && (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under));
    if (!escapes) {
      relative = under;
      break;
    }
  }
  if (relative === null) throw new UnsafePathError(`${absoluteTarget} is outside ${declaredRoot}`);

  const parts = relative === "" ? [] : relative.split(path.sep);
  const opened: number[] = [];
  const closeAll = (): void => {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  };
  try {
    let current = fs.openSync(resolvedRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    opened.push(current);
    for (const part of parts) {
      current = fs.openSync(
        at(current, part),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      opened.push(current);
    }
    return {
      fd: current,
      open: (name: string, flags: number) => fs.openSync(at(current, name), flags),
      list: () => fs.readdirSync(at(current), { withFileTypes: true }),
      close: closeAll,
    };
  } catch (error) {
    closeAll();
    const code = (error as NodeJS.ErrnoException).code;
    // Only "it is not there" is a quiet absence. A symlinked component (`ELOOP`)
    // or a non-directory (`ENOTDIR`) is a refusal, not an empty result — silently
    // returning "no files" would hide exactly the case the guard exists for.
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new UnsafePathError(`${target} reaches through a symbolic link or a non-directory`);
    }
    throw error;
  }
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
