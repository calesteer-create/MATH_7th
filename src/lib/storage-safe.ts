/**
 * Symlink-safe file operations for the upload directory.
 *
 * `src/lib/storage.ts` keeps its public behaviour; the primitives below are the
 * ones that touch the filesystem. They exist so a symlink or a concurrent swap
 * planted inside the upload root cannot redirect a write or a delete.
 *
 * **How, and how far.** A textual path can be re-pointed at any moment; a
 * directory descriptor cannot. Every operation here is performed relative to
 * descriptors opened component by component (`src/lib/dirfd.ts`), so no path is
 * resolved twice and there is no check-then-use window to race:
 *
 * - creation: `mkdir` one level at a time against a pinned parent descriptor —
 *   never `mkdir({recursive: true})`, which follows a symlinked component;
 * - opening: `O_EXCL` refuses an existing entry instead of truncating it, so a
 *   misdirected open cannot destroy anything; `O_NOFOLLOW` refuses a link at the
 *   leaf, and every directory component was opened with `O_NOFOLLOW|O_DIRECTORY`;
 * - truncation: only on a descriptor already proven to be a regular file, so an
 *   `O_TRUNC`-style race cannot empty a file before it is validated;
 * - deletion: `unlinkat` against the parent descriptor, so the directory cannot
 *   move between the check and the removal.
 *
 * **What this does not guarantee.** Descriptors remove the *path* race; they do
 * not defend against an attacker who already has write access inside the root
 * and mutates the bytes of a file whose descriptor we hold — no userspace design
 * does. Nor do they help on a platform with no descriptor namespace: that case
 * is refused explicitly rather than silently downgraded to path re-resolution.
 * See the TOCTOU section of docs/CONTENT_MODEL.md.
 *
 * This module is deliberately dependency-light so importing it never pulls in
 * the media-tooling code (and its `sharp` dependency) at request time.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { at, makeDirPath, OpenDir, openDir, openDirUnder, UnsafeComponentError } from "./dirfd";

export class UnsafeStoragePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStoragePathError";
  }
}

/** Re-expresses a component refusal in this module's public error type. */
function asStoragePathError(error: unknown): unknown {
  if (error instanceof UnsafeComponentError) {
    return new UnsafeStoragePathError(error.message);
  }
  return error;
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
export function resolveExistingPrefix(target: string): string {
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
/**
 * Maps a target to the components below the root, or refuses it.
 *
 * Lexical only: it decides *what to open*. Safety comes from the descriptors the
 * walk produces, never from this comparison — which is why a hostile key is
 * rejected here, and a hostile *name* is stopped later by `O_NOFOLLOW`.
 */
function partsBelow(root: string, target: string): string[] {
  const declared = path.resolve(root);
  const absolute = path.resolve(target);
  const resolvedRoot = resolveExistingPrefix(declared);
  const candidates = resolvedRoot === declared ? [declared] : [declared, resolvedRoot];
  for (const candidate of candidates) {
    const under = path.relative(candidate, absolute);
    const escapes =
      under !== "" && (under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under));
    if (!escapes) return under === "" ? [] : under.split(path.sep);
  }
  throw new UnsafeStoragePathError(`invalid storage key: ${absolute} is outside ${declared}`);
}

/**
 * Opens the root, creating it — and any missing ancestors below the nearest
 * existing one — one level at a time, each `mkdir` relative to a descriptor.
 *
 * The root itself is the one component resolved through `realpath`: the operator
 * names it, and its ancestors may be symlinks by design (macOS `/tmp`).
 */
function openRoot(root: string, create: boolean): OpenDir {
  const resolvedRoot = resolveExistingPrefix(path.resolve(root));
  const missing: string[] = [];
  let base = resolvedRoot;
  while (lstatOrNull(base) === null) {
    missing.push(path.basename(base));
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }
  const ordered = missing.reverse();

  const baseHandle = openDir(base);
  try {
    if (ordered.length > 0 && create) makeDirPath(baseHandle, ordered);
    // `openDirUnder` re-opens the inode, so the returned handle owns its own
    // descriptors and closing it can never close `baseHandle`'s numbers.
    const handle = openDirUnder(baseHandle, ordered);
    baseHandle.close();
    return handle;
  } catch (error) {
    baseHandle.close();
    throw error;
  }
}

export async function writeInsideUploadRoot(root: string, target: string, data: Buffer): Promise<void> {
  const parts = partsBelow(root, target);
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) {
    throw new UnsafeStoragePathError(`cannot write to the upload root itself: ${target}`);
  }
  // Serialised by the resolved target: the write is several syscalls, so two
  // overlapping calls for one key could otherwise splice their payloads.
  return serialize(`${path.resolve(root)}\u0000${parts.join("/")}`, () =>
    writeSerialized(root, parts.slice(0, -1), leaf, data),
  );
}

async function writeSerialized(root: string, dirParts: string[], leaf: string, data: Buffer): Promise<void> {
  try {
    await writeSerializedInner(root, dirParts, leaf, data);
  } catch (error) {
    throw asStoragePathError(error);
  }
}

async function writeSerializedInner(root: string, dirParts: string[], leaf: string, data: Buffer): Promise<void> {
  const constants = fsSync.constants;
  // The root handle is acquired *inside* the guarded region: every later step —
  // creating levels, opening the parent, opening the leaf — can fail, and each of
  // those failures must still close it. Anything done before the `try` would leak
  // a descriptor per refused write.
  let rootHandle: ReturnType<typeof openRoot> | null = null;
  let parent: ReturnType<typeof openDirUnder> | null = null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let created = false;
  let committed = false;
  let failure: unknown = null;
  try {
    rootHandle = openRoot(root, true);
    // Every directory below the root is created relative to a descriptor, so
    // `mkdir` cannot be redirected by a swap of the textual path.
    makeDirPath(rootHandle, dirParts);
    parent = openDirUnder(rootHandle, dirParts);
    if (parent === null) throw new UnsafeStoragePathError(`cannot open ${dirParts.join("/")}`);
    const pinned = parent;

    try {
      // The leaf is opened relative to the pinned parent, so the name cannot move.
      // `O_EXCL` refuses an existing entry instead of truncating it.
      handle = await fs.open(
        at(pinned.fd, leaf),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o644,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // It exists: open for writing without truncating, then prove — on the
      // descriptor — that it is a regular file inside this directory.
      handle = await fs.open(at(pinned.fd, leaf), constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    }

    const stat = await handle.stat();
    if (!stat.isFile()) throw new UnsafeStoragePathError(`${at(pinned.fd, leaf)} is not a regular file`);
    // Truncation only here, on a descriptor obtained through the pinned chain.
    await handle.truncate(0);
    await handle.write(data, 0, data.length, 0);
    committed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    // Cleanup happens while `parent` is still open: the removal is `unlinkat`
    // against the pinned descriptor, so it can only reach an entry in this
    // directory. Closing first and then unlinking by `<ns>/<fd>/name` would be a
    // use-after-close — the number can be reused by an unrelated open, and the
    // unlink would then land in whatever directory that new descriptor names.
    if (!committed && created && parent !== null) {
      try {
        parent.unlink(leaf);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          failure =
            failure === null
              ? new UnsafeStoragePathError(`left ${leaf} behind in the upload root: ${String(error)}`)
              : failure;
        }
      }
    }
    parent?.close();
    rootHandle?.close();
  }
  if (failure !== null) throw failure;
}

/** Deletes `target` only if it is a real file inside the root. */
export async function deleteInsideUploadRoot(root: string, target: string): Promise<void> {
  try {
    await deleteInsideUploadInner(root, target);
  } catch (error) {
    throw asStoragePathError(error);
  }
}

async function deleteInsideUploadInner(root: string, target: string): Promise<void> {
  const parts = partsBelow(root, target);
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) throw new UnsafeStoragePathError(`cannot delete the upload root itself: ${target}`);

  const rootHandle = openRoot(root, false);
  let parent: OpenDir | null = null;
  try {
    parent = openDirUnder(rootHandle, parts.slice(0, -1));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    rootHandle.close();
    if (code === "ENOENT") return; // nothing there, nothing to delete
    throw error;
  }

  try {
    // `lstat` through the descriptor: a link at the leaf is visible as a link,
    // and is refused rather than unlinked — removing a link is not the same as
    // removing the file the caller believes it is deleting.
    let stat: fsSync.Stats;
    try {
      stat = parent.lstat(leaf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeStoragePathError(`${at(parent.fd, leaf)} is a symbolic link`);
    }
    if (!stat.isFile()) {
      throw new UnsafeStoragePathError(`${at(parent.fd, leaf)} is not a regular file`);
    }
    // `unlinkat` against the descriptor, not `unlink(path)`: the directory cannot
    // be swapped out from under this call.
    parent.unlink(leaf);
  } finally {
    parent.close();
    rootHandle.close();
  }
}
