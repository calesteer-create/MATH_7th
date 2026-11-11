import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { detectMime, storeLessonImage } from "@/lib/images";
import { mediaRoot, readKey } from "@/lib/storage";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "math7-img-"));
  process.env.UPLOAD_DIR = tmp;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A neutral technical test image: a grid pattern. No curriculum content.
async function makeJpeg(width = 1600, height = 2200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f5f5f0"/>
    <g stroke="#999" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 180}" x2="${width}" y2="${i * 180}"/>`).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

describe("upload sniffing", () => {
  it("detects formats from bytes, not filenames", async () => {
    const jpg = await makeJpeg(200, 200);
    expect(detectMime(jpg)).toBe("image/jpeg");
    expect(detectMime(await sharp(jpg).png().toBuffer())).toBe("image/png");
    expect(detectMime(await sharp(jpg).webp().toBuffer())).toBe("image/webp");
    expect(detectMime(Buffer.from("not an image at all"))).toBeNull();
  });
});

describe("lesson image storage", () => {
  it("stores an archival original plus web and thumbnail renditions", async () => {
    const jpeg = await makeJpeg();
    const stored = await storeLessonImage(jpeg, 42);

    expect(stored.storageKey).toMatch(/^lessons\/42\/original\//);
    expect(stored.webKey).toMatch(/^lessons\/42\/web\/.*\.webp$/);
    expect(stored.thumbKey).toMatch(/^lessons\/42\/thumb\/.*\.webp$/);
    expect(stored.mime).toBe("image/jpeg");
    expect(stored.sha256).toHaveLength(64);

    // Inside the media root, and readable back.
    expect(mediaRoot()).toBe(path.resolve(tmp));
    const original = await readKey(stored.storageKey);
    expect(original?.byteLength).toBe(jpeg.byteLength);

    const webMeta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(webMeta.format).toBe("webp");
    expect(webMeta.width).toBeLessThanOrEqual(2200);

    const thumbMeta = await sharp((await readKey(stored.thumbKey))!).metadata();
    expect(thumbMeta.width).toBeLessThanOrEqual(480);
  });

  it("downscales an oversized page but keeps aspect ratio", async () => {
    const stored = await storeLessonImage(await makeJpeg(4000, 5000), 7);
    const meta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(meta.width).toBeLessThanOrEqual(2200);
    expect(Math.abs((meta.width! / meta.height!) - 4000 / 5000)).toBeLessThan(0.01);
  });

  it("rejects a non-image upload", async () => {
    await expect(storeLessonImage(Buffer.from("<html>nope</html>"), 1)).rejects.toThrow(
      "unsupported_format",
    );
  });

  it("strips EXIF so a page scan cannot leak GPS coordinates", async () => {
    const withExif = await sharp(await makeJpeg(400, 400))
      .withExif({ IFD0: { ImageDescription: "geo-tagged" } })
      .jpeg()
      .toBuffer();
    const stored = await storeLessonImage(withExif, 99);
    const meta = await sharp((await readKey(stored.webKey))!).metadata();
    expect(meta.exif).toBeUndefined();
  });
});

/**
 * The upload directory is written by the admin server, not only by the media
 * CLI, so it needs the same rule: a symlink planted inside it must not redirect
 * a write or a delete outside the root.
 */
describe("upload storage refuses symlink escapes", () => {
  let base: string;
  let uploadRoot: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-store-symlink-"));
    uploadRoot = path.join(base, "uploads");
    outside = path.join(base, "outside");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "ORIGINAL-BYTES");
    fs.symlinkSync(outside, path.join(uploadRoot, "images"));
    process.env.UPLOAD_DIR = uploadRoot;
  });

  afterAll(() => {
    process.env.UPLOAD_DIR = tmp;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked directory", async () => {
    const { writeKey } = await import("@/lib/storage");
    await expect(writeKey("images/evil.bin", Buffer.from("PAYLOAD"))).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("refuses to delete through a symlinked directory", async () => {
    const { resolveKey } = await import("@/lib/storage");
    expect(() => resolveKey("images/keep.txt")).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("still stores and reads a legitimate key", async () => {
    const { writeKey, readKey } = await import("@/lib/storage");
    await writeKey("real/ok.bin", Buffer.from("OK"));
    expect((await readKey("real/ok.bin"))?.toString("utf8")).toBe("OK");
  });
});

/**
 * Point 5 of the review: the root policy used to be documented one way and
 * implemented the other. The root is chosen by the operator, so it may itself
 * be a symlink (macOS `/tmp` is); everything below it may not.
 */
describe("root symlink policy", () => {
  let base: string;
  let real: string;
  let link: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-rootpolicy-"));
    real = path.join(base, "real");
    link = path.join(base, "link");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link);
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("accepts a root that is itself a symlink", async () => {
    const { resolveInside } = await import("@/media/tree");
    // Targets are expressed in the root's own namespace, which is what every
    // caller does (`path.join(root, …)`).
    expect(() => resolveInside(link, path.join(link, "lessons", "1.json"))).not.toThrow();
  });

  it("accepts either spelling of a symlinked root, and returns the resolved one", async () => {
    const { resolveInside } = await import("@/media/tree");
    // A root with two names ("link" and "real") is still one boundary. Both
    // spellings must work, and both must come back in the *resolved* namespace —
    // the earlier design returned a resolved path that its own callers then
    // re-checked against the unresolved root, which rejected valid writes.
    const viaLink = resolveInside(link, path.join(link, "lessons", "1.json"));
    const viaReal = resolveInside(link, path.join(real, "lessons", "1.json"));
    const expected = path.join(fs.realpathSync(real), "lessons", "1.json");
    expect(viaLink).toBe(expected);
    expect(viaReal).toBe(expected);
  });

  it("still refuses a target that is under neither spelling", async () => {
    const { resolveInside } = await import("@/media/tree");
    expect(() => resolveInside(link, path.join(base, "elsewhere.json"))).toThrow(/outside/);
  });

  it("still refuses a symlink below the root", async () => {
    const { resolveInside } = await import("@/media/tree");
    const escape = path.join(base, "escape");
    fs.mkdirSync(escape, { recursive: true });
    fs.symlinkSync(escape, path.join(real, "linked"));
    expect(() => resolveInside(link, path.join(link, "linked", "x.json"))).toThrow(/symbolic link/);
  });

  it("refuses a target outside the root even when the root is a symlink", async () => {
    const { resolveInside } = await import("@/media/tree");
    expect(() => resolveInside(link, path.join(base, "elsewhere.json"))).toThrow(/outside/);
  });
});

/**
 * A symlinked upload root is a normal deployment (macOS `/tmp`, a mounted
 * volume). These drive the public `writeKey`/`readKey`/`deleteKey` surface —
 * not the resolver — because the bug this guards was that the resolver's
 * *return value* was in a different namespace than its callers expected.
 */
describe("upload storage with a symlinked root", () => {
  let base: string;
  let realDir: string;
  let linkDir: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-linked-root-"));
    realDir = path.join(base, "real_uploads");
    linkDir = path.join(base, "uploads_link");
    outside = path.join(base, "outside");
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "ORIGINAL-BYTES");
    fs.symlinkSync(realDir, linkDir);
    process.env.UPLOAD_DIR = linkDir;
  });

  afterAll(() => {
    process.env.UPLOAD_DIR = tmp;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("writes through a symlinked root into the real directory", async () => {
    const { writeKey } = await import("@/lib/storage");
    await writeKey("lesson/page.webp", Buffer.from("PAYLOAD"));

    const onReal = path.join(realDir, "lesson", "page.webp");
    expect(fs.existsSync(onReal)).toBe(true);
    expect(fs.readFileSync(onReal, "utf8")).toBe("PAYLOAD");
    // Nothing appeared anywhere else.
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("reads it back through the same root", async () => {
    const { readKey } = await import("@/lib/storage");
    const data = await readKey("lesson/page.webp");
    expect(data?.toString("utf8")).toBe("PAYLOAD");
  });

  it("deletes only the intended file", async () => {
    const { writeKey, deleteKey } = await import("@/lib/storage");
    await writeKey("lesson/other.webp", Buffer.from("SECOND"));
    await deleteKey("lesson/page.webp");

    expect(fs.existsSync(path.join(realDir, "lesson", "page.webp"))).toBe(false);
    // The sibling survives, and so does everything outside the root.
    expect(fs.readFileSync(path.join(realDir, "lesson", "other.webp"), "utf8")).toBe("SECOND");
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
  });

  it("refuses an escaping link through the public interface, silently for deleteKey", async () => {
    const { writeKey, deleteKey, resolveKey } = await import("@/lib/storage");
    fs.symlinkSync(outside, path.join(realDir, "images"));

    await expect(writeKey("images/evil.bin", Buffer.from("X"))).rejects.toThrow(/symbolic link/);
    expect(() => resolveKey("images/keep.txt")).toThrow(/symbolic link/);
    // deleteKey swallows errors by contract, so the assertion is on the bytes.
    await deleteKey("images/keep.txt");
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");

    fs.unlinkSync(path.join(realDir, "images"));
  });
});

/**
 * The root may also be reached through a symlinked *ancestor*, not only through
 * a symlink at the root itself: `realpathSync` resolves the whole chain.
 */
describe("upload storage with a symlinked ancestor", () => {
  let base: string;
  let realParent: string;
  let linkedParent: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-linked-parent-"));
    realParent = path.join(base, "real_parent");
    linkedParent = path.join(base, "linked_parent");
    fs.mkdirSync(realParent, { recursive: true });
    fs.symlinkSync(realParent, linkedParent);
    process.env.UPLOAD_DIR = path.join(linkedParent, "uploads");
  });

  afterAll(() => {
    process.env.UPLOAD_DIR = tmp;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolves the ancestor chain and writes at the real location", async () => {
    const { writeKey, readKey, resolveKey } = await import("@/lib/storage");

    // The resolved namespace is what makes the rest of the design consistent:
    // the kernel would follow the ancestor symlink on its own, so "the bytes
    // landed somewhere" proves nothing. What must hold is that the key resolves
    // to the real path, so callers and comparisons agree.
    expect(resolveKey("a/b.bin")).toBe(path.join(fs.realpathSync(realParent), "uploads", "a", "b.bin"));
    expect(resolveKey("a/b.bin").startsWith(linkedParent)).toBe(false);

    await writeKey("a/b.bin", Buffer.from("ANCESTOR"));
    const landed = path.join(realParent, "uploads", "a", "b.bin");
    expect(fs.readFileSync(landed, "utf8")).toBe("ANCESTOR");
    expect((await readKey("a/b.bin"))?.toString("utf8")).toBe("ANCESTOR");
  });

  it("still refuses a symlink below a root reached through a symlinked ancestor", async () => {
    const { writeKey, resolveKey } = await import("@/lib/storage");
    const outsideDir = path.join(base, "outside-anc");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "keep.txt"), "ORIGINAL");
    // The escape sits under the *real* parent, i.e. below the resolved root.
    fs.mkdirSync(path.join(realParent, "uploads"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(realParent, "uploads", "escape"));

    expect(() => resolveKey("escape/keep.txt")).toThrow(/symbolic link/);
    await expect(writeKey("escape/evil.bin", Buffer.from("X"))).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outsideDir)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outsideDir, "keep.txt"), "utf8")).toBe("ORIGINAL");
  });
});

/**
 * The post-`mkdir` re-check must be measured against the upload root. Passing
 * the created directory as its own root makes the check vacuous — every path is
 * inside itself — and hides a component that has become a symlink.
 */
/**
 * Concurrency evidence, deliberately labelled as such.
 *
 * This is **not** a regression test in the strict sense: it asserts an invariant
 * ("no payload byte of ours ever lands outside the root") rather than a
 * difference from a previous commit, and the invariant is only probabilistically
 * exercised. Passing it does NOT prove the race is closed — Node exposes no
 * dirfd-relative `openat`, so a swap that wins the window remains possible. It
 * exists so a *worsening* of the guard fails the suite instead of shipping
 * silently. If it fails, treat it as a genuine escape, not a flake.
 */
describe("a directory swapped for a link while writing (best-effort)", () => {
  let base: string;
  let uploadRoot: string;
  let outside: string;
  let swapper: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-swap-"));
    uploadRoot = path.join(base, "uploads");
    outside = path.join(base, "outside");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    // A like-for-like attacker: the swap runs in another process, so it does not
    // merely interleave at our own `await` points.
    swapper = path.join(base, "swapper.cjs");
    fs.writeFileSync(
      swapper,
      `const fs=require("fs"),path=require("path");
       const [root,outside]=process.argv.slice(2);
       const target=path.join(root,"swapped");
       for(let i=0;i<60000;i++){
         try{fs.rmSync(target,{recursive:true,force:true});}catch{}
         try{ i%2 ? fs.mkdirSync(target) : fs.symlinkSync(outside,target); }catch{}
       }`,
    );
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("never publishes our bytes outside the root", async () => {
    const { writeInsideUploadRoot } = await import("@/lib/storage-safe");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [swapper, uploadRoot, outside], { stdio: "ignore" });
    const target = path.join(uploadRoot, "swapped", "page.webp");

    try {
      for (let attempt = 0; attempt < 800; attempt += 1) {
        await writeInsideUploadRoot(uploadRoot, target, Buffer.from("PAYLOAD")).catch(() => undefined);
      }
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }

    // The invariant: however the race landed, no file outside carries our bytes.
    // A directory may exist there (mkdir is not atomic with the guard — see the
    // documented limit) and a zero-length file may too, but never a payload.
    const leaked: string[] = [];
    for (const entry of fs.readdirSync(outside, { recursive: true })) {
      const full = path.join(outside, String(entry));
      const stat = fs.lstatSync(full);
      if (stat.isFile() && fs.readFileSync(full, "utf8").includes("PAYLOAD")) leaked.push(String(entry));
    }
    expect(leaked).toEqual([]);
  });
});

describe("the re-check after mkdir uses the upload root, not the directory", () => {
  let base: string;
  let uploadRoot: string;
  let outside: string;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-recheck-"));
    uploadRoot = path.join(base, "uploads");
    outside = path.join(base, "outside");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "keep.txt"), "ORIGINAL-BYTES");
    process.env.UPLOAD_DIR = uploadRoot;
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("re-walks the chain against the upload root instead of trusting the directory", async () => {
    const { resolveInsideUploadRoot, writeInsideUploadRoot } = await import("@/lib/storage-safe");

    // (a) A link that already exists is caught by the *first* check, so it does
    // not discriminate between the two designs — assert it anyway, because it is
    // the case users hit.
    const existing = path.join(uploadRoot, "existing-link");
    fs.symlinkSync(outside, existing);
    expect(() => resolveInsideUploadRoot(uploadRoot, path.join(existing, "page.webp"))).toThrow(
      /symbolic link/,
    );

    // (b) The case that does discriminate: the directory is real when the first
    // check runs, and a link by the time the second one must run. Measured as the
    // old code measured it — the directory as its own root — the check passes and
    // the write escapes; measured against the upload root it is refused.
    const swapped = path.join(uploadRoot, "swapped");
    fs.mkdirSync(swapped, { recursive: true });
    expect(() => resolveInsideUploadRoot(uploadRoot, path.join(swapped, "page.webp"))).not.toThrow();
    fs.rmSync(swapped, { recursive: true, force: true });
    fs.symlinkSync(outside, swapped);

    expect(() => resolveInsideUploadRoot(swapped, swapped)).not.toThrow(); // the old, vacuous form
    expect(() => resolveInsideUploadRoot(uploadRoot, path.join(swapped, "page.webp"))).toThrow(
      /symbolic link/,
    );

    // And the primitive refuses the same state rather than writing through it.
    await expect(
      writeInsideUploadRoot(uploadRoot, path.join(swapped, "page.webp"), Buffer.from("PAYLOAD")),
    ).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
  });

  it("re-checks the target itself, so a linked final component cannot ride along", async () => {
    const { writeInsideUploadRoot } = await import("@/lib/storage-safe");
    // A directory-only check cannot see a symlinked final component; the guard is
    // applied to the full target, and `O_NOFOLLOW` backs it up at the syscall.
    const dir = path.join(uploadRoot, "final");
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, "page.webp");
    fs.symlinkSync(path.join(outside, "keep.txt"), link);

    await expect(writeInsideUploadRoot(uploadRoot, link, Buffer.from("PAYLOAD"))).rejects.toThrow(
      /symbolic link/,
    );
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("ORIGINAL-BYTES");
    expect(fs.readdirSync(outside)).toEqual(["keep.txt"]);
  });

  it("still writes when every component is real", async () => {
    const { writeInsideUploadRoot } = await import("@/lib/storage-safe");
    const target = path.join(uploadRoot, "plain", "deep", "ok.bin");
    await writeInsideUploadRoot(uploadRoot, target, Buffer.from("OK"));
    expect(fs.readFileSync(target, "utf8")).toBe("OK");
  });
});
