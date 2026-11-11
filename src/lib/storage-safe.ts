/**
 * Symlink-safe file operations for the upload directory.
 *
 * `src/lib/storage.ts` keeps its public behaviour; the primitives below are the
 * ones that touch the filesystem. They exist so a symlink planted inside the
 * upload root cannot redirect a write or a delete to somewhere else, on the same
 * component policy Phase 2's media tooling enforces via
 * `src/media/tree.ts#resolveInside`: **every** component below the root is
 * checked with `lstat` and any symlink — directory or file, first or last — is
 * refused. The root itself is the one exception, resolved once through
 * `realpath`, because the operator names it explicitly.
 *
 * Why not `resolve` + `startsWith`: the kernel follows a symlinked *directory*
 * component in `open(2)`/`unlink(2)`, so a path that merely *looks* contained
 * still lands outside. `O_NOFOLLOW` is not a substitute for this walk either: it
 * constrains only the final component, so a link in a parent directory is
 * traversed by the kernel regardless of the flags.
 *
 * **What this does not guarantee** (see the TOCTOU note in
 * docs/CONTENT_MODEL.md). Every check below is separated from its use by a
 * window, and Node exposes no dirfd-relative `openat`/`mkdirat`:
 *
 * - `mkdir({recursive: true})` follows a symlinked component, so a component
 *   swapped between the last check and the call causes the directories to be
 *   created at the link's target. The re-check that follows *detects* this and
 *   refuses the write, but the empty directory tree may already exist outside.
 * - A component swapped between the pre-open check and `open(2)` is caught
 *   afterwards by `realpath` on the opened path, before any byte is written —
 *   which limits the damage to an empty file created at the link target, and
 *   that file is removed on the refusal path.
 * - A swap that happens *after* the open is not detectable through these APIs.
 *   The guarantee is therefore "a validated path that is still valid at the
 *   moment it is observed", not "no concurrent mutation can ever escape".
 *
 * This module is deliberately dependency-light so importing it never pulls in
 * the media-tooling code (and its `sharp` dependency) at request time.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class UnsafeStoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStoragePathError";
  }
}

function lstatOrNull(target: string): fsSync.Stats | null {
  try {
    return fsSync.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolves `target` under `root`, refusing any symlink below the root.
 *
 * Two namespaces, one boundary: `realpathSync` resolves the root *and every
 * ancestor* (macOS `/tmp` → `/private/tmp`), and a root with two names accepts
 * both spellings. The value returned is always in the **resolved** namespace,
 * and callers must use it as returned — re-checking a resolved path against the
 * unresolved root is what previously made uploads to a symlinked root fail.
 */
export function resolveInsideUploadRoot(root: string, target: string): string {
  const declaredRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);

  // The root may not exist yet (the first write creates it), but its ancestors
  // might, and one of them might be a symlink — a mounted volume, macOS /tmp.
  // Resolving the existing part is what makes the returned path a *real* path
  // rather than a spelling that merely happens to work today.
  const resolvedRoot = resolveExistingPrefix(declaredRoot);
  const rootStat = lstatOrNull(resolvedRoot);
  if (rootStat !== null && !rootStat.isDirectory()) {
    throw new UnsafeStoragePathError(`upload root ${declaredRoot} is not a directory`);
  }

  // A root with two names has two valid spellings; the returned value is always
  // the resolved one, so callers never mix namespaces.
  const candidates = resolvedRoot === declaredRoot ? [declaredRoot] : [declaredRoot, resolvedRoot];
  let relative: string | null = null;
  for (const candidate of candidates) {
    const under = path.relative(candidate, absoluteTarget);
    const escapes = under !== "" && (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under));
    if (!escapes) {
      relative = under;
      break;
    }
  }
  if (relative === null) {
    throw new UnsafeStoragePathError(`invalid storage key: ${absoluteTarget} is outside ${declaredRoot}`);
  }

  const absoluteResolvedTarget = relative === "" ? resolvedRoot : path.join(resolvedRoot, relative);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = resolvedRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null) break;
    if (stat.isSymbolicLink()) {
      throw new UnsafeStoragePathError(`${current} is a symbolic link`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new UnsafeStoragePathError(`${current} is not a directory`);
    }
  }
  return absoluteResolvedTarget;
}

/**
 * `realpath` for a path that may not exist yet: resolves the longest existing
 * prefix and re-appends the rest. This is how a not-yet-created upload root
 * still gets a real, symlink-free base.
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
  const resolvedBase = lstatOrNull(current) === null ? current : fsSync.realpathSync(current);
  return missing.length === 0 ? resolvedBase : path.join(resolvedBase, ...missing.reverse());
}

/**
 * Serialises writes to the same target within this process.
 *
 * The write is now three syscalls (probe-create, identity check, truncate+write)
 * instead of one, so two overlapping calls for the same key would interleave and
 * one payload would be spliced into the other. Keys are generated per upload, so
 * a collision means the same key was written twice concurrently — the last
 * writer must win, as it did when a single `open` did the whole job. Serialising
 * restores that: one payload, never a mixture. It is per-process only, which is
 * all a single-owner deployment needs.
 */
const inflight = new Map<string, Promise<void>>();

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = inflight.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  // The queued marker never rejects: its job is only to order the next write, and
  // an unhandled rejection here would take the process down instead of surfacing
  // through the caller's own promise.
  const marker = next.then(
    () => undefined,
    () => undefined,
  );
  inflight.set(key, marker);
  // Drop the entry once it is idle, so the map does not grow without bound on a
  // long-running server.
  void marker.then(() => {
    if (inflight.get(key) === marker) inflight.delete(key);
  });
  return next;
}

/** Writes `data` at `target`, never through a symlink, creating parents safely. */
export async function writeInsideUploadRoot(root: string, target: string, data: Buffer): Promise<void> {
  const safeTarget = resolveInsideUploadRoot(root, target);
  // Serialised by target: see `serialize` for why a multi-step write needs it.
  return serialize(safeTarget, () => writeSerialized(root, safeTarget, data));
}

/**
 * Walks from an already-open directory descriptor down to `target`'s parent.
 *
 * This is the `openat` loop Node does not expose directly: each component is
 * opened *relative to the previous descriptor* via `/proc/self/fd/<n>`, so a
 * component swapped in the textual path cannot redirect the walk. The descriptor
 * the kernel hands back is pinned to the directory it actually opened, which is
 * what every later step works from.
 *
 * `O_NOFOLLOW` on each `open` refuses a symlinked component; `O_DIRECTORY`
 * refuses anything that is not a directory. Both are enforced by the kernel, not
 * re-checked afterwards.
 */
function openDirChain(root: string, parts: string[]): { fd: number; close: () => void } {
  const constants = fsSync.constants;
  const opened: number[] = [];
  const closeAll = (): void => {
    for (const fd of opened.reverse()) {
      try {
        fsSync.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  };
  let current: number;
  try {
    // `makeDirChain` runs first in the write path, so the root exists here; the
    // resolved prefix is used for the same reason as there.
    current = fsSync.openSync(
      resolveExistingPrefix(path.resolve(root)),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    opened.push(current);
    for (const part of parts) {
      // Creating a missing component is a separate, explicit step: the caller
      // truncates the walk where the first missing component begins.
      current = fsSync.openSync(
        fdPath(current, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      opened.push(current);
    }
    return { fd: current, close: closeAll };
  } catch (error) {
    closeAll();
    throw error;
  }
}

/**
 * The path that lets a descriptor be used as an `*at` base: Linux
 * `/proc/self/fd`, macOS/BSD `/dev/fd`. Resolved once and proved by listing a
 * real descriptor, so an unsupported platform fails loudly here instead of
 * silently degrading to path re-resolution.
 */
let fdNamespace: string | null | undefined;

function resolveFdNamespace(): string {
  if (fdNamespace !== undefined) {
    if (fdNamespace === null) {
      throw new UnsafeStoragePathError(
        "no /proc/self/fd or /dev/fd: descriptor-relative access is unavailable on this platform, " +
          "and falling back to path re-resolution would reintroduce the race",
      );
    }
    return fdNamespace;
  }
  for (const candidate of ["/proc/self/fd", "/dev/fd"]) {
    try {
      const probe = fsSync.openSync(os.tmpdir(), fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
      try {
        fsSync.readdirSync(`${candidate}/${probe}`);
      } finally {
        fsSync.closeSync(probe);
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

function fdPath(fd: number, child?: string): string {
  const base = `${resolveFdNamespace()}/${fd}`;
  return child === undefined ? base : `${base}/${child}`;
}

/**
 * Creates the missing directories of `parts` one level at a time, each `mkdir`
 * relative to a pinned descriptor.
 *
 * `fs.mkdir(recursive: true)` is avoided deliberately: it follows a symlinked
 * component and is not atomic with respect to any check. Here every level is an
 * `mkdirat` against the descriptor of its parent, so a swap of the textual path
 * is irrelevant — the descriptor is the base. A pre-existing component is opened
 * as a directory, which refuses a symlink (`O_NOFOLLOW`) rather than following
 * it.
 */
function makeDirChain(root: string, parts: string[]): void {
  const constants = fsSync.constants;
  const opened: number[] = [];
  const closeAll = (): void => {
    for (const fd of opened.reverse()) {
      try {
        fsSync.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  };
  try {
    // The root itself may not exist yet (the first write creates it), and its
    // ancestors may be symlinks the operator chose. It is therefore the one
    // component resolved through `realpath`; everything below it is fd-relative.
    const resolvedRoot = resolveExistingPrefix(path.resolve(root));
    const missingRoot: string[] = [];
    let existingBase = resolvedRoot;
    while (lstatOrNull(existingBase) === null) {
      missingRoot.push(path.basename(existingBase));
      const parent = path.dirname(existingBase);
      if (parent === existingBase) break;
      existingBase = parent;
    }
    let current = fsSync.openSync(
      existingBase,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    opened.push(current);
    for (const part of [...missingRoot.reverse(), ...parts]) {
      try {
        fsSync.mkdirSync(fdPath(current, part));
      } catch (error) {
        // EEXIST is acceptable only if the entry is a real directory; the open
        // below enforces that with O_NOFOLLOW | O_DIRECTORY.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      current = fsSync.openSync(
        fdPath(current, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      opened.push(current);
    }
  } finally {
    closeAll();
  }
}

async function writeSerialized(root: string, safeTarget: string, data: Buffer): Promise<void> {
  const relative = path.relative(resolveExistingPrefix(path.resolve(root)), safeTarget);
  const parts = relative === "" ? [] : relative.split(path.sep);
  const leaf = parts.pop();
  if (leaf === undefined) throw new UnsafeStoragePathError(`cannot write to the upload root itself: ${safeTarget}`);

  // Every directory below the root is created fd-relative, so `mkdir` can no
  // longer be redirected by a swap of the textual path.
  makeDirChain(root, parts);
  const parent = openDirChain(root, parts);
  const target = fdPath(parent.fd, leaf);
  const constants = fsSync.constants;

  let handle: Awaited<ReturnType<typeof fs.open>>;
  let created = false;
  try {
    // The leaf is opened *relative to the pinned parent descriptor*, so the
    // resolved path cannot move under us. `O_EXCL` refuses an existing entry
    // instead of truncating it; `O_NOFOLLOW` refuses a link.
    handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      parent.close();
      throw error;
    }
    // It exists: open it for writing without truncating, then prove the
    // descriptor is a file inside the pinned directory before emptying it.
    handle = await fs.open(target, constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
  }

  let committed = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new UnsafeStoragePathError(`${safeTarget} is not a regular file`);
    }
    // Truncation happens here and only here: on a descriptor obtained through a
    // pinned directory chain, so there is no path left to swap.
    await handle.truncate(0);
    await handle.write(data, 0, data.length, 0);
    committed = true;
  } finally {
    parent.close();
    await handle.close().catch(() => undefined);
    if (!committed && created) {
      // The unlink is relative to the still-pinned parent descriptor, so it can
      // only ever remove the entry this call created. If the descriptor is gone,
      // the file is reported rather than removed through a re-resolved path.
      try {
        fsSync.unlinkSync(target);
      } catch {
        /* reported below by the caller's error */
      }
    }
  }
}

/**
 * Opens a target that already exists, without giving it the chance to be
 * damaged first.
 *
 * Used only when the exclusive probe reported `EEXIST`. The open appends
 * (`O_APPEND`) and not truncates, so even a swapped component can only have
 * bytes added at the end — and the bytes are discarded by the `truncate(0)` that
 * follows a successful identity check. Anything that is not `EEXIST` is a real
 * failure and is rethrown unchanged.
 */
async function openExistingInsideRoot(
  root: string,
  safeTarget: string,
  cause: unknown,
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  const flags = fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_NOFOLLOW;
  const handle = await fs.open(safeTarget, flags, 0o644);
  // Identity is proved by the caller for both branches; nothing is written here.
  return handle;
}

/**
 * Proves the descriptor refers to a file inside `root`, and returns its identity.
 *
 * Two checks, because either alone is unsound:
 *
 * 1. `realpath` on the path the guard validated — it re-walks the chain, so a
 *    component that is *currently* a link is caught.
 * 2. `dev`/`ino` of the open descriptor against the `dev`/`ino` of the resolved
 *    path. This is what catches the swap-and-restore attack: the attacker points
 *    the component outside, lets the kernel open the outside file, then restores
 *    the directory before `realpath` runs. The path then resolves inside and
 *    check 1 passes, but the descriptor still refers to the outside inode, and
 *    the identities differ.
 *
 * Neither check closes the race — a swap *after* both leaves the descriptor
 * valid and the writes go to the file it names. There is no dirfd-relative
 * access in Node to do better, which is why the write path is also arranged so
 * that the window cannot be used to *destroy* anything: no `O_TRUNC` before the
 * identity is proven, and no `O_CREAT` through a path that may still move.
 */
async function assertOpenedInsideRoot(
  root: string,
  safeTarget: string,
  handle: { stat: () => Promise<fsSync.Stats> },
): Promise<{ dev: number; ino: number }> {
  const resolvedRoot = resolveExistingPrefix(path.resolve(root));
  const actual = await fs.realpath(safeTarget);
  const under = path.relative(resolvedRoot, actual);
  if (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under)) {
    throw new UnsafeStoragePathError(`${safeTarget} resolves to ${actual}, outside ${resolvedRoot}`);
  }

  // The identity check: the descriptor and the *same* resolved path must name one
  // file. `stat` (not `lstat`) follows the path the kernel would follow now.
  const opened = await handle.stat();
  const named = await fs.stat(actual);
  if (opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new UnsafeStoragePathError(
      `${safeTarget} was opened at a different file (${opened.dev}:${opened.ino}) than it now names ` +
        `(${named.dev}:${named.ino}); a directory component changed during the write`,
    );
  }
  return { dev: opened.dev, ino: opened.ino };
}

/**
 * Removes a file this call created, but only after re-proving by inode that the
 * path still names it.
 *
 * The `lstat`-then-`unlink` sequence is not safe on its own: a directory
 * component can change between the two calls, so the `lstat` blesses one file and
 * the `unlink` removes another. Here the consecutive check is by identity
 * (`dev`/`ino`) and the path is re-resolved first, so a deleted file is provably
 * the one created. When that cannot be proved, this throws and the caller reports
 * the leftover instead of deleting something it cannot vouch for.
 */
async function removeIfStillOurs(
  root: string,
  safeTarget: string,
  identity: { dev: number; ino: number } | undefined,
): Promise<void> {
  if (identity === undefined) return; // nothing was proven, so nothing is removed
  const resolvedRoot = resolveExistingPrefix(path.resolve(root));
  const actual = await fs.realpath(safeTarget).catch(() => null);
  if (actual === null) return; // already gone
  const under = path.relative(resolvedRoot, actual);
  if (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under)) return;
  const stat = await fs.lstat(actual);
  if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return;
  await fs.unlink(actual);
}

/** Deletes `target` only if it is a real file inside the root. */
export async function deleteInsideUploadRoot(root: string, target: string): Promise<void> {
  const safeTarget = resolveInsideUploadRoot(root, target);
  // A symlink at the final component is refused by the resolver above; unlinking
  // a real file inside the root removes that file and nothing it points at.
  const stat = lstatOrNull(safeTarget);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new UnsafeStoragePathError(`${safeTarget} is a symbolic link`);
  }
  await fs.unlink(safeTarget);
}
