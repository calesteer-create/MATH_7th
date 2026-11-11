import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  deleteInsideUploadRoot,
  resolveExistingPrefix,
  resolveInsideUploadRoot,
  writeInsideUploadRoot,
} from "./storage-safe";
import { OpenDir, openDir, openDirUnder, relativeParts } from "./dirfd";

/**
 * Local-disk media store.
 *
 * A single-owner deployment does not need object storage: a directory on a
 * persistent volume is simpler to operate and to back up (copy two paths). The
 * interface is key-based so an S3 adapter can be dropped in later without
 * touching callers.
 */
function root(): string {
  return path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? "./data/uploads");
}

/**
 * Resolves a key inside the media root and refuses anything that escapes it.
 *
 * The returned value is a *spelling* for callers that need one (logging, keys
 * echoed back); it is not proof that the location is safe. Every read and write
 * re-derives the location from descriptors, so this function is never used as a
 * check whose result is later acted upon by a path syscall.
 */
export function resolveKey(key: string): string {
  const base = root();
  // turbopackIgnore keeps the bundler from tracing the whole project for this
  // dynamic root; the media directory lives outside the server output.
  const target = path.resolve(/* turbopackIgnore: true */ base, key);
  // Lexical containment: cheap, and it rejects hostile keys outright. The
  // symlink and swap guarantees come from the descriptor walk in storage-safe.
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("invalid storage key");
  }
  return resolveInsideUploadRoot(base, target);
}

export async function writeKey(key: string, data: Buffer): Promise<void> {
  await writeInsideUploadRoot(root(), resolveKey(key), data);
}

/**
 * Reads a key through a pinned parent descriptor.
 *
 * `resolveKey(key)` followed by `find readFile(path)` would be a check-then-use
 * pair separated by a window: the directory could be swapped for a link in
 * between and the read would land outside the root. Here the parent directory is
 * opened descriptor-relatively, the leaf is opened relative to it with
 * `O_NOFOLLOW`, and both `fstat` and the read use that descriptor — so what is
 * verified is exactly what is read.
 */
/**
 * The root spelling that `resolveKey`'s result belongs to.
 *
 * A root with two names ("link" and "real") is one boundary. `resolveKey`
 * returns the **resolved** spelling, so components must be taken from the
 * resolved root; measuring them against the declared one would make every
 * component look like an escape. `resolveExistingPrefix` is the same resolution
 * the guard uses, so the two never disagree.
 */
function partsBase(declaredRoot: string): string {
  return resolveExistingPrefix(declaredRoot);
}

export async function readKey(key: string): Promise<Buffer | null> {
  // Three resources, each closed exactly once, in reverse order of acquisition:
  // the root handle, the parent handle and the file descriptor. Passing
  // `openDir(...)` straight into `openDirUnder(...)` would drop the root handle on
  // the floor and leak one descriptor per read.
  let rootHandle: OpenDir | null = null;
  let parent: OpenDir | null = null;
  let fd: number | null = null;
  try {
    const base = root();
    // `resolveKey` returns the path in the *resolved* namespace (a symlinked
    // root has two names), so the components must be taken from the resolved
    // root. Mixing the declared root with a resolved target yields a `..`
    // prefix and would silently read nothing.
    const target = resolveKey(key);
    const resolvedBase = partsBase(base);
    const parts = relativeParts(resolvedBase, target);
    const leaf = parts.pop();
    if (leaf === undefined) return null;

    // The root may not exist on a fresh deployment; absence is a `null`, not an
    // error, which is what the previous `readFile`-in-a-try-catch did.
    if (!fsSync.existsSync(resolvedBase)) return null;

    rootHandle = openDir(resolvedBase);
    parent = openDirUnder(rootHandle, parts);
    // `O_NONBLOCK` keeps the *open* from blocking when the entry is a FIFO: opening
    // one for reading waits for a writer, which would hang the request before the
    // type could be checked. The flag does not change how a regular file is read.
    fd = parent.open(
      leaf,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK,
    );
    // `fstat` on the descriptor: a symlinked leaf is refused by O_NOFOLLOW
    // already, and anything that is not a regular file is not served.
    if (!fsSync.fstatSync(fd).isFile()) return null;
    // `node:fs/promises` will not take a numeric descriptor; the sync form does
    // and still reads from the descriptor, which is the point.
    return fsSync.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fsSync.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    parent?.close();
    rootHandle?.close();
  }
}

export async function deleteKey(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await deleteInsideUploadRoot(root(), resolveKey(key));
  } catch {
    /* already gone — deleting twice must not fail a request */
  }
}

export function mediaRoot(): string {
  return root();
}

export function newKey(prefix: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  return `${prefix}/${crypto.randomBytes(12).toString("hex")}.${safeExt.toLowerCase()}`;
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function ensureMediaRoot(): void {
  fsSync.mkdirSync(root(), { recursive: true });
}
