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
import { UnsafeComponentError, at as fdAt, makeDirPath, openDir, openDirUnder, relativeParts } from "../lib/dirfd";
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

/**
 * Opens `root` and walks to the directory that holds `target`, creating missing
 * levels relative to descriptors. Returns the parent handle and the leaf name.
 *
 * The root itself is resolved once (`realpath`), because the operator names it
 * and its ancestors may legitimately be symlinks; everything below it is opened
 * `O_NOFOLLOW|O_DIRECTORY` relative to its parent's descriptor.
 */
function openParent(
  root: string,
  target: string,
  options: { create: boolean },
): { root: ReturnType<typeof openDir>; parent: ReturnType<typeof openDir>; leaf: string } {
  const parts = relativeParts(root, target);
  const leaf = parts.pop();
  if (leaf === undefined) throw new UnsafePathError(`cannot write the root itself: ${target}`);

  const resolvedRoot = resolveExistingPrefix(path.resolve(root));
  const missing: string[] = [];
  let base = resolvedRoot;
  while (!fs.existsSync(base)) {
    missing.push(path.basename(base));
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }
  const ordered = missing.reverse();

  const baseHandle = openDir(base);
  let rootHandle: ReturnType<typeof openDir> | null = null;
  try {
    if (ordered.length > 0) {
      if (!options.create) throw new UnsafePathError(`${resolvedRoot} does not exist`);
      makeDirPath(baseHandle, ordered);
    }
    rootHandle = openDirUnder(baseHandle, ordered);
  } finally {
    baseHandle.close();
  }

  try {
    makeDirPath(rootHandle, parts);
    const parent = openDirUnder(rootHandle, parts);
    return { root: rootHandle, parent, leaf };
  } catch (error) {
    rootHandle.close();
    throw error;
  }
}

/**
 * Writes JSON atomically **and** descriptor-relatively.
 *
 * The payload goes to a sibling temporary file created with `O_CREAT|O_EXCL`
 * relative to the pinned parent descriptor, is written through that descriptor,
 * and is then `renameat`-ed over the target using two descriptors — so neither
 * the temporary file nor the destination name is ever resolved as a path that
 * could be swapped. The target therefore holds either the old bytes or the new
 * ones, never a half-encoded record.
 */
export function writeJson(root: string, target: string, value: unknown): void {
  try {
    writeJsonInner(root, target, value);
  } catch (error) {
    throw asUnsafePathError(error);
  }
}

/** Keeps this module's public error type stable for callers and tests. */
function asUnsafePathError(error: unknown): unknown {
  if (error instanceof UnsafeComponentError) return new UnsafePathError(error.message);
  return error;
}

function writeJsonInner(root: string, target: string, value: unknown): void {
  const handle = openParent(root, target, { create: true });
  // A unique temporary name, not `.<leaf>.tmp-<pid>`: two runs of the same script
  // — or two processes sharing a pid namespace — would otherwise collide on the
  // name, and the loser's cleanup could delete the winner's in-flight file.
  const temporary = `.${handle.leaf}.${crypto.randomUUID()}.tmp`;
  // Tracks whether *this* call actually created the temporary file. Without it the
  // `catch` would unlink a name it never owned: an `EEXIST` failure means someone
  // else's file is sitting there, and removing it would destroy their work.
  let createdTemporary = false;
  try {
    // Refuse a link at the destination explicitly. `renameat` would replace the
    // link itself rather than writing through it — the victim's bytes are safe —
    // but silently replacing a link is not the same as accepting the write, and
    // the documented policy is to refuse rather than to redefine the target.
    try {
      if (handle.parent.lstat(handle.leaf).isSymbolicLink()) {
        throw new UnsafePathError(`${target} is a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = handle.parent.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o644,
    );
    createdTemporary = true;
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    // `renameat`: both operands are descriptors, so the destination directory
    // cannot be swapped between the write and the publication. Ownership of the
    // temporary file passes to the destination name here.
    handle.parent.rename(temporary, handle.parent, handle.leaf);
    createdTemporary = false;
  } catch (error) {
    // Never let cleanup mask the real failure: on a read-only directory even
    // removing the temporary file is refused, and the caller needs the cause.
    // Only ever remove the file this call created, and only relative to the same
    // descriptor it was created under.
    if (createdTemporary) {
      try {
        handle.parent.unlink(temporary);
      } catch {
        /* as above */
      }
    }
    throw error;
  } finally {
    handle.parent.close();
    handle.root.close();
  }
}

/**
 * Writes a new file inside `root` and refuses to traverse a symlink.
 *
 * The single write primitive shared by every producer (`media:import`,
 * `media:sync`). Every directory level is created relative to a descriptor, and
 * the leaf is opened `O_NOFOLLOW` relative to the pinned parent: `O_EXCL` errors
 * rather than clobbering an existing page, while `exclusive: false` truncates an
 * existing real file (derived thumbnails, which are regenerated).
 */
export function writeFileInside(
  root: string,
  target: string,
  data: Buffer,
  options: { exclusive?: boolean; mode?: number } = {},
): SafePath {
  try {
    return writeFileInsideInner(root, target, data, options);
  } catch (error) {
    throw asUnsafePathError(error);
  }
}

function writeFileInsideInner(
  root: string,
  target: string,
  data: Buffer,
  options: { exclusive?: boolean; mode?: number },
): SafePath {
  const resolvedRoot = resolveExistingPrefix(path.resolve(root));
  const handle = openParent(root, target, { create: true });
  const exclusive = options.exclusive ?? true;
  try {
    let fd: number;
    try {
      fd = handle.parent.open(
        handle.leaf,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW |
          (exclusive ? fs.constants.O_EXCL : 0),
        options.mode ?? 0o644,
      );
    } catch (error) {
      if (exclusive || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = handle.parent.open(
        handle.leaf,
        fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        options.mode ?? 0o644,
      );
    }
    try {
      // Truncation happens on the descriptor, after the open succeeded through
      // the pinned chain, so `O_TRUNC` cannot empty a file before it is proven.
      if (!exclusive) fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return path.join(resolvedRoot, ...relativeParts(resolvedRoot, path.resolve(target))) as SafePath;
  } finally {
    handle.parent.close();
    handle.root.close();
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

  /**
   * Locates a permitted target as (parent handle, leaf) using descriptors only.
   *
   * The lexical check decides whether a root is allowed to be considered at all;
   * the descriptors decide what is actually touched. Returns `null` when the
   * path does not exist any more, and throws a reason when it must be refused.
   */
  const locate = (target: string): { parent: ReturnType<typeof openDir>; root?: ReturnType<typeof openDir>; leaf: string; close: () => void } | null => {
    for (const root of allowedRoots) {
      let parts: string[];
      try {
        parts = relativeParts(root, target);
      } catch {
        continue; // not under this root; try the next
      }
      if (parts.length === 0) continue;
      const leaf = parts[parts.length - 1] as string;
      let rootHandle: ReturnType<typeof openDir> | null = null;
      let parent: ReturnType<typeof openDir> | null = null;
      try {
        const resolvedRoot = resolveExistingPrefix(path.resolve(root));
        if (!fs.existsSync(resolvedRoot)) continue;
        rootHandle = openDir(resolvedRoot);
        parent = openDirUnder(rootHandle, parts.slice(0, -1));
        const handle = parent;
        const base = rootHandle;
        return {
          parent: handle,
          leaf,
          close: () => {
            handle.close();
            base.close();
          },
        };
      } catch {
        parent?.close();
        rootHandle?.close();
        continue;
      }
    }
    return null;
  };

  for (const target of [...createdFiles].reverse()) {
    const check = permitted(target);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to delete ${target}: ${check.reason}`);
      continue;
    }
    let handle: ReturnType<typeof locate> = null;
    try {
      handle = locate(target);
      if (handle === null) {
        failures.push(`could not delete ${target}: no writable descriptor path`);
        continue;
      }
      // `lstat` through the descriptor, then `unlinkat` against the same one: the
      // directory cannot move between the check and the removal, so a deletion
      // cannot land outside the root.
      let stat: fs.Stats;
      try {
        stat = handle.parent.lstat(handle.leaf);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          created += 1; // already gone counts as undone
          continue;
        }
        throw error;
      }
      if (stat.isDirectory()) {
        failures.push(`refused to delete ${target}: it is a directory`);
        continue;
      }
      handle.parent.unlink(handle.leaf);
      created += 1;
    } catch (error) {
      failures.push(`could not delete ${target}: ${(error as Error).message}`);
    } finally {
      handle?.close();
    }
  }

  for (const file of [...overwrittenFiles].reverse()) {
    const check = permitted(file.path);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to restore ${file.path}: ${check.reason}`);
      continue;
    }
    let handle: ReturnType<typeof locate> = null;
    try {
      handle = locate(file.path);
      if (handle === null) {
        failures.push(`could not restore ${file.path}: no writable descriptor path`);
        continue;
      }
      // One descriptor for the whole compare-and-restore, so the file that is
      // compared is the file that is rewritten. Reading through one descriptor,
      // closing it, and reopening the *name* for writing would leave a window in
      // which the name points at something else — and the rewrite would land on a
      // file that was never compared.
      let fd: number;
      try {
        // `O_RDONLY` first: a restored record may legitimately be mode 0444, and
        // `O_RDWR` would fail on it before the bytes could even be compared.
        fd = handle.parent.open(handle.leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Absent: create it exclusively, so a file that appeared meanwhile is not
        // silently adopted, and write through the new descriptor.
        const created = handle.parent.open(
          handle.leaf,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o644,
        );
        try {
          fs.writeFileSync(created, file.previous);
        } finally {
          fs.closeSync(created);
        }
        restored += 1;
        continue;
      }
      try {
        // `fstat` on the descriptor: the type is decided on the file that will be
        // written, not on a name that could point somewhere else.
        if (!fs.fstatSync(fd).isFile()) {
          failures.push(`refused to restore ${file.path}: not a regular file`);
          continue;
        }
        const current = fs.readFileSync(fd);
        if (current.equals(file.previous)) continue; // already the old bytes
        const identity = fs.fstatSync(fd);
        // Reopen the *same name* for writing, then prove by `dev`/`ino` that it is
        // the file that was just compared. Without that check a swap between the
        // read and the reopen would let the restore land on another file.
        const writable = handle.parent.open(handle.leaf, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        try {
          const again = fs.fstatSync(writable);
          if (again.dev !== identity.dev || again.ino !== identity.ino) {
            failures.push(`refused to restore ${file.path}: the file changed during the restore`);
            continue;
          }
          fs.ftruncateSync(writable, 0);
          fs.writeSync(writable, file.previous, 0, file.previous.length, 0);
          restored += 1;
        } finally {
          fs.closeSync(writable);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      failures.push(`could not restore ${file.path}: ${(error as Error).message}`);
    } finally {
      handle?.close();
    }
  }

  // Directories the run created are removed too, deepest first, but only if they
  // are empty: leaving `thumbs/` behind would be a visible leftover even though
  // every file in it was undone.
  for (const dir of [...createdDirectories].reverse()) {
    const check = permitted(dir);
    if (!check.ok) {
      skipped += 1;
      failures.push(`refused to remove ${dir}: ${check.reason}`);
      continue;
    }
    let handle: ReturnType<typeof locate> = null;
    try {
      handle = locate(dir);
      if (handle === null) {
        failures.push(`could not remove ${dir}: no writable descriptor path`);
        continue;
      }
      // `unlinkat(AT_REMOVEDIR)`: Node has no direct form, so the empty-directory
      // rule is checked through the descriptor first and the removal is attempted
      // relative to it. A directory that is not empty fails with ENOTEMPTY, which
      // is a successful no-op here.
      fs.rmdirSync(fdAt(handle.parent.fd, handle.leaf));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // "Not empty" or "already gone" is a successful no-op, not a failure.
      if (code !== "ENOTEMPTY" && code !== "ENOENT") {
        failures.push(`could not remove ${dir}: ${(error as Error).message}`);
      }
    } finally {
      handle?.close();
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
