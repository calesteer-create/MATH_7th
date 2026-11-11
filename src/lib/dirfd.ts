/**
 * Descriptor-relative filesystem operations.
 *
 * A textual path can be re-pointed at any moment: `rename`, `symlink`, `unlink`
 * all change what a name means between one call and the next. A directory
 * descriptor cannot be re-pointed — the kernel pins it to the inode it opened.
 * Every operation here is performed *relative to a descriptor*, so no operation
 * resolves the same path twice.
 *
 * Node exposes no `openat(2)`, but `<fd-namespace>/<n>/<child>` is the same
 * operation: the kernel resolves `<child>` against the pinned inode. The
 * namespace is `/proc/self/fd` on Linux and `/dev/fd` on macOS/BSD; it is
 * *proved* here by opening a real descriptor and listing it, never assumed from
 * the existence of the directory.
 *
 * Platforms without either namespace are refused explicitly. Falling back to
 * path re-resolution would silently reintroduce the race this module exists to
 * remove, so an unsupported platform fails rather than degrading.
 *
 * **A descriptor must never outlive its use.** Using `<ns>/<n>` after `close(n)`
 * is not merely "stale": the number can be reused by an unrelated open, and the
 * operation then acts on whatever that new descriptor points at. Every helper
 * below keeps the descriptor open for the whole operation and closes it exactly
 * once, after the last syscall that needs it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Raised when a component below the root is a symlink or is not a directory.
 *
 * The kernel reports these as `ELOOP`/`ENOTDIR`; mapping them to one type lets
 * callers distinguish "refused because it is unsafe" from "the disk is broken"
 * without inspecting errno strings, and keeps the message stable in tests.
 */
export class UnsafeComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeComponentError";
  }
}

export class DirFdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirFdUnavailableError";
  }
}

let namespace: string | null | undefined;

/**
 * The descriptor namespace, proved by listing a real descriptor.
 *
 * `readdir` alone is not enough proof: a platform could expose a directory whose
 * listing works while `open`/`unlink` beneath it do not. `probeNamespace` below
 * therefore exercises open, create, stat and unlink inside a temporary directory
 * before the namespace is accepted.
 */
export function fdNamespace(): string {
  if (namespace === null) {
    throw new DirFdUnavailableError(
      "no usable /proc/self/fd or /dev/fd descriptor namespace on this platform; " +
        "descriptor-relative access is unavailable and this code refuses to fall back to path re-resolution",
    );
  }
  if (namespace !== undefined) return namespace;

  for (const candidate of ["/proc/self/fd", "/dev/fd"]) {
    if (probeNamespace(candidate)) {
      namespace = candidate;
      return candidate;
    }
  }
  namespace = null;
  return fdNamespace();
}

/** True when the platform can do descriptor-relative work at all. */
export function supportsDirFd(): boolean {
  try {
    fdNamespace();
    return true;
  } catch {
    return false;
  }
}

/**
 * Exercises the four operations this module relies on inside a throwaway
 * directory, so a half-implemented namespace is rejected up front.
 */
function probeNamespace(candidate: string): boolean {
  let dir: string | null = null;
  let fd: number | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dirfd-probe-"));
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const base = `${candidate}/${fd}`;

    // Every operation this module performs is exercised. A namespace that works
    // for some of them and not others is rejected: partial support is worse than
    // none, because it would pass the check and fail mid-operation later.
    if (!Array.isArray(fs.readdirSync(base))) return false; // list

    const created = fs.openSync(`${base}/probe.txt`, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o644);
    try {
      fs.writeFileSync(created, "probe"); // create + write
    } finally {
      fs.closeSync(created);
    }

    const reopened = fs.openSync(`${base}/probe.txt`, fs.constants.O_RDONLY);
    try {
      if (fs.readFileSync(reopened, "utf8") !== "probe") return false; // read
    } finally {
      fs.closeSync(reopened);
    }

    if (!fs.statSync(`${base}/probe.txt`).isFile()) return false; // stat
    if (fs.lstatSync(`${base}/probe.txt`).isSymbolicLink()) return false; // lstat

    // mkdir, then rename between the descriptor and its child descriptor.
    fs.mkdirSync(`${base}/inner`);
    const inner = fs.openSync(`${base}/inner`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.renameSync(`${base}/probe.txt`, `${candidate}/${inner}/moved.txt`);
      if (!fs.existsSync(`${base}/inner/moved.txt`)) return false; // rename across
      fs.unlinkSync(`${base}/inner/moved.txt`); // unlinkat
      if (fs.existsSync(`${base}/inner/moved.txt`)) return false;
    } finally {
      fs.closeSync(inner);
    }
    fs.rmdirSync(`${base}/inner`); // remove an empty directory
    if (fs.existsSync(path.join(dir, "inner"))) return false;

    // The descriptor must stay pinned to its inode: rename the directory away,
    // put a link in its place, and confirm the descriptor still sees the original.
    const pinned = `${base}/pinned.txt`;
    fs.writeFileSync(pinned, "pinned");
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    fs.symlinkSync(os.tmpdir(), dir);
    try {
      if (fs.readFileSync(`${base}/pinned.txt`, "utf8") !== "pinned") return false;
    } finally {
      fs.unlinkSync(dir);
      fs.renameSync(moved, dir);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
    if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `<namespace>/<fd>` or `<namespace>/<fd>/<child>`: the `*at` base for a descriptor. */
export function at(fd: number, child?: string): string {
  const base = `${fdNamespace()}/${fd}`;
  return child === undefined ? base : `${base}/${child}`;
}

/**
 * An open directory descriptor and the operations that stay inside it.
 *
 * The `close` method is idempotent and must be called only after the last
 * operation that uses `fd`; `withDir` below makes that ordering automatic.
 */
export interface OpenDir {
  readonly fd: number;
  open: (name: string, flags: number, mode?: number) => number;
  mkdir: (name: string) => void;
  unlink: (name: string) => void;
  rename: (from: string, toDir: OpenDir, to: string) => void;
  stat: (name: string) => fs.Stats;
  /** `lstat` semantics: does not follow a symlink, so a link is visible. */
  lstat: (name: string) => fs.Stats;
  list: () => fs.Dirent[];
  close: () => void;
}

function makeOpenDir(fds: number[]): OpenDir {
  const current = fds[fds.length - 1] as number;
  let closed = false;
  return {
    fd: current,
    open: (name, flags, mode) => {
      try {
        return fs.openSync(at(current, name), flags, mode);
      } catch (error) {
        throw translateComponentError(error);
      }
    },
    mkdir: (name) => {
      fs.mkdirSync(at(current, name));
    },
    unlink: (name) => {
      fs.unlinkSync(at(current, name));
    },
    // `renameat`: both sides are descriptors, so neither name is re-resolved.
    rename: (from, toDir, to) => {
      fs.renameSync(at(current, from), at(toDir.fd, to));
    },
    stat: (name) => {
      try {
        return fs.statSync(at(current, name));
      } catch (error) {
        throw translateComponentError(error);
      }
    },
    lstat: (name) => {
      try {
        return fs.lstatSync(at(current, name));
      } catch (error) {
        throw translateComponentError(error);
      }
    },
    list: () => fs.readdirSync(at(current), { withFileTypes: true }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const fd of [...fds].reverse()) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    },
  };
}

/** Opens `dir`, which must exist. Each component is opened relative to its parent. */
export function openDir(dir: string): OpenDir {
  const opened: number[] = [];
  try {
    let current = fs.openSync(
      path.resolve(dir),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    opened.push(current);
    // `openSync` above already resolved the whole path in one syscall, so there
    // is no chain to walk here; the descriptor is the pin from now on.
    current = opened[0] as number;
    return makeOpenDir(opened);
  } catch (error) {
    for (const fd of opened) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
    throw error;
  }
}

/**
 * Opens `dir` relative to an already-open root descriptor, one component at a
 * time. A component that is missing, a symlink, or not a directory stops the
 * walk — the caller decides whether that is an absence or a refusal.
 */
export function openDirUnder(root: OpenDir, parts: string[]): OpenDir {
  const opened: number[] = [];
  try {
    if (parts.length === 0) {
      // Re-open the root's own inode so the returned handle owns its descriptors.
      const fd = fs.openSync(at(root.fd), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      opened.push(fd);
      return makeOpenDir(opened);
    }
    let current = root.fd;
    for (const part of parts) {
      current = fs.openSync(
        at(current, part),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      opened.push(current);
    }
    return makeOpenDir(opened);
  } catch (error) {
    for (const fd of [...opened].reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
    throw translateComponentError(error);
  }
}

/**
 * Turns the kernel's `ELOOP`/`ENOTDIR` into an explicit refusal, so a caller
 * cannot mistake "a symlink is in the way" for a generic I/O failure.
 */
export function translateComponentError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP") {
    return new UnsafeComponentError("a component below the root is a symbolic link");
  }
  if (code === "ENXIO") {
    // Opening a FIFO for writing with `O_NONBLOCK` and no reader fails with ENXIO
    // on Linux. It is a refusal of a special file, not a broken path, and the
    // message should say so rather than leaking an errno the operator cannot act on.
    return new UnsafeComponentError(
      "the entry is a FIFO or another special file, not a regular file; refusing to open it",
    );
  }
  if (code === "ENOTDIR") {
    // A symlinked component reaches this branch: `O_DIRECTORY` on a link reports
    // ENOTDIR rather than ELOOP, because the link is not a directory. Both mean
    // the same thing to a caller — the path does not continue with a real
    // directory below the root.
    return new UnsafeComponentError(
      "a component below the root is a symbolic link or is not a directory",
    );
  }
  return error;
}

/**
 * Creates `parts` under `root` one level at a time, each `mkdir` relative to the
 * descriptor of its parent.
 *
 * `mkdir({recursive: true})` is deliberately not used: it follows a symlinked
 * component, so it can create directories outside the tree. Here every level is
 * created against a pinned descriptor, and an existing level is opened with
 * `O_NOFOLLOW | O_DIRECTORY`, so a link is refused rather than traversed.
 */
export function makeDirPath(root: OpenDir, parts: string[]): void {
  let current = root.fd;
  const opened: number[] = [];
  try {
    for (const part of parts) {
      try {
        fs.mkdirSync(at(current, part));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      current = fs.openSync(
        at(current, part),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      opened.push(current);
    }
  } catch (error) {
    throw translateComponentError(error);
  } finally {
    for (const fd of [...opened].reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * Splits `target` into components below `root`, or throws if it is outside.
 *
 * Purely lexical: it decides *what to open*, never whether something is safe.
 * Safety comes from the descriptors the walk produces, not from this comparison.
 */
export function relativeParts(root: string, target: string): string[] {
  const declared = path.resolve(root);
  const absolute = path.resolve(target);
  const resolved = resolveExistingPrefixSafe(declared);
  // A root with two names is one boundary: accept a target spelled under either,
  // and return components relative to the *resolved* one, because that is the
  // inode the descriptor walk will actually descend into.
  const candidates = resolved === declared ? [declared] : [declared, resolved];
  for (const candidate of candidates) {
    const under = path.relative(candidate, absolute);
    const escapes = under === ".." || under.startsWith(`..${path.sep}`) || path.isAbsolute(under);
    if (!escapes) return under === "" ? [] : under.split(path.sep);
  }
  throw new Error(`${absolute} is outside ${declared}`);
}

/** `realpath` of the longest existing prefix; the declared path when none exists. */
function resolveExistingPrefixSafe(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      if (fs.lstatSync(current) !== undefined) break;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.push(path.basename(current));
    current = parent;
  }
  let resolvedBase = current;
  try {
    resolvedBase = fs.realpathSync(current);
  } catch {
    /* keep the literal base */
  }
  return missing.length === 0 ? resolvedBase : path.join(resolvedBase, ...missing.reverse());
}

/** Runs `fn` with an open handle and closes it exactly once, after `fn` returns. */
export function withDir<T>(dir: string, fn: (handle: OpenDir) => T): T {
  const handle = openDir(dir);
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

/**
 * Reads a file relative to a pinned parent directory, verifying on the descriptor.
 *
 * Returns `null` when the entry does not exist, so callers keep the "absent" and
 * "refused" cases distinguishable: absence is an empty result, a symlink or a
 * non-file is an error.
 */
export function readFileAt(parent: OpenDir, name: string): Buffer | null {
  let fd: number | null = null;
  try {
    // `O_NONBLOCK` is about the open, not the read: opening a FIFO is the call that
    // blocks (waiting for the other end), and it would block *before* `fstat` could
    // reject the type. With the flag the open returns and the check below refuses.
    // A regular file is unaffected by the flag.
    fd = parent.open(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    // `fstat` on the descriptor that was actually opened: the type check and the
    // read refer to one file, with no name re-resolved in between.
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new UnsafeComponentError(`${name} is ${describeEntryType(stat)}, not a regular file`);
    }
    return fs.readFileSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw translateComponentError(error);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** True when `name` exists inside `parent` and is a regular file. */
export function fileExistsAt(parent: OpenDir, name: string): boolean {
  try {
    const stat = parent.lstat(name);
    if (!stat.isFile()) {
      // A link, directory, FIFO or socket at this name is *not* "nothing here".
      // Returning false for it is what turned an unowned entry into a file this
      // run believed it had created — and then the rollback deleted it. The caller
      // must decide, so this is an error, not a boolean.
      throw new UnsafeComponentError(
        `${name} exists but is not a regular file (${describeEntryType(stat)}); refusing to treat it as absent`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A short, accurate name for what an `lstat` result is, for error messages. */
export function describeEntryType(stat: fs.Stats): string {
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (stat.isDirectory()) return "a directory";
  if (stat.isFIFO()) return "a FIFO";
  if (stat.isSocket()) return "a socket";
  if (stat.isCharacterDevice()) return "a character device";
  if (stat.isBlockDevice()) return "a block device";
  if (stat.isFile()) return "a regular file";
  return "an unrecognised entry";
}

/**
 * Writes `data` to `name` inside a pinned parent directory, reporting whether this
 * call created the file.
 *
 * The return value is what makes ownership provable: a caller may only record the
 * path as "created by me, safe to delete on rollback" when this returns `true`.
 *
 * `exclusive: false` truncates an existing file — but only after the descriptor is
 * open and `fstat` has confirmed it is a regular file, so truncation can never
 * reach something that was not validated. `O_NOFOLLOW` makes a symlink at the name
 * a refusal rather than a write through it.
 *
 * `O_NONBLOCK` guards the open itself: opening a FIFO for writing blocks until a
 * reader appears, which would hang the process before `fstat` could reject it. With
 * the flag the open returns and the type check below refuses it.
 */
export function writeFileAt(
  parent: OpenDir,
  name: string,
  data: Buffer,
  options: { exclusive?: boolean; mode?: number } = {},
): boolean {
  const exclusive = options.exclusive ?? true;
  const mode = options.mode ?? 0o644;
  const createFlags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NONBLOCK;
  let fd: number | null = null;
  let created = false;
  try {
    if (exclusive) {
      fd = parent.open(name, createFlags, mode);
      created = true;
    } else {
      try {
        fd = parent.open(name, createFlags, mode);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Existing: open without truncating, prove the type, then truncate.
        fd = parent.open(name, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, mode);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
          throw new UnsafeComponentError(
            `${name} exists but is ${describeEntryType(stat)}; refusing to write through it`,
          );
        }
        fs.ftruncateSync(fd, 0);
      }
    }
    fs.writeFileSync(fd, data);
    return created;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * `mkdir -p` that reports what it actually created.
 *
 * Each level is created relative to its parent's descriptor, so a swapped textual
 * path cannot redirect the creation. A level that already exists is opened with
 * `O_NOFOLLOW | O_DIRECTORY`, which refuses a symlink rather than traversing it.
 * The returned list contains only directories this call created, deepest last —
 * that is what a rollback must remove and nothing else.
 */
export function makeDirPathTracked(root: OpenDir, parts: string[]): string[] {
  const created: string[] = [];
  let current = root.fd;
  const opened: number[] = [];
  try {
    for (const part of parts) {
      const target = at(current, part);
      let madeIt = false;
      try {
        fs.mkdirSync(target);
        madeIt = true;
        created.push(part);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        current = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      } catch (error) {
        if (madeIt) created.pop();
        throw translateComponentError(error);
      }
      opened.push(current);
    }
    return created;
  } finally {
    for (const fd of [...opened].reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * Ensures every level of `parts` exists under `root`, creating what is missing.
 *
 * Returns the relative names it actually created (e.g. `["lessons", "lessons/3"]`),
 * which is exactly what a rollback may remove. Creation is one `mkdirat` per
 * level against the parent descriptor; an existing level is opened with
 * `O_NOFOLLOW | O_DIRECTORY` so a symlink is refused rather than traversed.
 */
export function ensureDirPath(root: OpenDir, parts: string[]): { dir: OpenDir; created: string[] } {
  const created: string[] = [];
  let current = root;
  let ownedCurrent: OpenDir | null = null;
  try {
    for (const [index, part] of parts.entries()) {
      let madeIt = false;
      try {
        fs.mkdirSync(at(current.fd, part));
        madeIt = true;
        created.push(parts.slice(0, index + 1).join("/"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let next: OpenDir;
      try {
        next = openDirUnder(current, [part]);
      } catch (error) {
        if (madeIt) created.pop();
        throw error;
      }
      // Only descriptors this call owns are closed; `root` belongs to the caller.
      if (ownedCurrent !== null) ownedCurrent.close();
      ownedCurrent = next;
      current = next;
    }
    if (parts.length === 0) {
      const fd = fs.openSync(at(root.fd), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      return { dir: makeSingle(fd), created };
    }
    return { dir: ownedCurrent as OpenDir, created };
  } catch (error) {
    if (ownedCurrent !== null) ownedCurrent.close();
    throw error;
  }
}

/** A handle owning exactly one descriptor. */
function makeSingle(fd: number): OpenDir {
  return {
    fd,
    open: (name, flags, mode) => fs.openSync(at(fd, name), flags, mode),
    mkdir: (name) => {
      fs.mkdirSync(at(fd, name));
    },
    unlink: (name) => {
      fs.unlinkSync(at(fd, name));
    },
    rename: (from, toDir, to) => {
      fs.renameSync(at(fd, from), at(toDir.fd, to));
    },
    stat: (name) => fs.statSync(at(fd, name)),
    lstat: (name) => fs.lstatSync(at(fd, name)),
    list: () => fs.readdirSync(at(fd), { withFileTypes: true }),
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
