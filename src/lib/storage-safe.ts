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
 * close to the syscall as this API allows (see `resolveInside` for the
 * documented limit: a concurrent swap between check and use is narrowed, not
 * impossible, without dirfd-relative openat).
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

/** Resolves `target` under `root`, refusing any symlink below the root. */
export function resolveInsideUploadRoot(root: string, target: string): string {
  const declaredRoot = path.resolve(root);
  let absoluteTarget = path.resolve(target);

  const declaredRelative = path.relative(declaredRoot, absoluteTarget);
  if (
    declaredRelative !== "" &&
    (declaredRelative === ".." ||
      declaredRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(declaredRelative))
  ) {
    throw new UnsafeStoragePathError(`invalid storage key: ${absoluteTarget} is outside ${declaredRoot}`);
  }

  // The upload root is chosen by the operator, so it may itself be a link.
  let absoluteRoot = declaredRoot;
  const rootStat = lstatOrNull(declaredRoot);
  if (rootStat !== null) {
    if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
      throw new UnsafeStoragePathError(`upload root ${declaredRoot} is not a directory`);
    }
    if (rootStat.isSymbolicLink()) {
      absoluteRoot = fsSync.realpathSync(declaredRoot);
      absoluteTarget = path.join(absoluteRoot, declaredRelative);
    }
  }

  const relative = path.relative(absoluteRoot, absoluteTarget);
  const parts = relative === "" ? [] : relative.split(path.sep);
  let current = absoluteRoot;
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
  return absoluteTarget;
}

/** Writes `data` at `target`, never through a symlink, creating parents safely. */
export async function writeInsideUploadRoot(root: string, target: string, data: Buffer): Promise<void> {
  const safeTarget = resolveInsideUploadRoot(root, target);
  const directory = path.dirname(safeTarget);
  await fs.mkdir(directory, { recursive: true });
  resolveInsideUploadRoot(root, directory);

  const flags =
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW;
  resolveInsideUploadRoot(root, directory);
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
