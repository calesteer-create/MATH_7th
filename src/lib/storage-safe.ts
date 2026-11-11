/**
 * Symlink-safe file operations for the upload directory.
 *
 * `src/lib/storage.ts` keeps its public behaviour; the primitives below are the
 * ones that touch the filesystem. They exist so a symlink planted inside the
 * upload root cannot redirect a write or a delete to somewhere else — the same
 * rule Phase 2's media tooling enforces via `src/media/tree.ts#resolveInside`.
 *
 * Why not `resolve` + `startsWith`: the kernel follows a symlinked *directory*
 * component in `open(2)`/`unlink(2)`, so a path that merely *looks* contained
 * still lands outside. Each component below the root is checked with `lstat`,
 * the final component is opened with `O_NOFOLLOW`, and the check is repeated as
 * close to the syscall as this API allows.
 *
 * **What this does not guarantee** (see the TOCTOU note in
 * docs/CONTENT_MODEL.md): every check here is separated from its use by a
 * window. `mkdir({recursive: true})` is *not* atomic with respect to the guard
 * — it follows a symlinked directory component, so if a component is swapped
 * for a link after the last check and before the mkdir, the directories are
 * created at the link's target. The subsequent re-check (measured against the
 * upload root) then *detects* the escape and nothing is written, but an empty
 * directory tree may already exist outside. Closing that fully needs
 * `openat`/`mkdirat` relative to a directory fd, which Node does not expose.
 *
 * This module is deliberately dependency-light so importing it never pulls in
 * the media-tooling code (and its `sharp` dependency) at request time.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
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

/** Writes `data` at `target`, never through a symlink, creating parents safely. */
export async function writeInsideUploadRoot(root: string, target: string, data: Buffer): Promise<void> {
  const safeTarget = resolveInsideUploadRoot(root, target);
  const directory = path.dirname(safeTarget);
  await fs.mkdir(directory, { recursive: true });

  // Re-verified against the *upload root*, never against `directory`: passing
  // the directory as its own root is a vacuous check (any path is inside
  // itself), so a component that became a symlink after `mkdir` would sail
  // through. Both the parent chain and the full target are re-walked, which also
  // catches a symlink at the final component.
  resolveInsideUploadRoot(root, safeTarget);

  const flags =
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW;
  // Again as close to the open as this API allows. `O_NOFOLLOW` then stops the
  // final component from being a link at the instant of the syscall.
  resolveInsideUploadRoot(root, safeTarget);
  const handle = await fs.open(safeTarget, flags, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
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
