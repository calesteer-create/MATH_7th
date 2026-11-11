import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  deleteInsideUploadRoot,
  resolveInsideUploadRoot,
  writeInsideUploadRoot,
} from "./storage-safe";

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

/** Resolves a key inside the media root and refuses anything that escapes it. */
export function resolveKey(key: string): string {
  const base = root();
  // turbopackIgnore keeps the bundler from tracing the whole project for this
  // dynamic root; the media directory lives outside the server output.
  const target = path.resolve(/* turbopackIgnore: true */ base, key);
  // Lexical containment first (cheap, and it rejects hostile keys outright),
  // then the symlink walk: a link inside the upload root must not redirect a
  // write or a delete outside it.
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("invalid storage key");
  }
  return resolveInsideUploadRoot(base, target);
}

export async function writeKey(key: string, data: Buffer): Promise<void> {
  await writeInsideUploadRoot(root(), resolveKey(key), data);
}

export async function readKey(key: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(resolveKey(key));
  } catch {
    return null;
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
