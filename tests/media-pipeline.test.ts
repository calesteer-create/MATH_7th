import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { MediaError, inspectWebp, processSourceImage, sha256Hex } from "@/media/process";
import { checkDeletion, buildReferenceIndex, collectQuizSourceImages, referencedFiles } from "@/media/references";
import { fileSha256, importImageIntoLesson, listLessonMediaFiles } from "@/media/import";
import { UnsafePathError, resolveInside, writeFileInside, writeJson } from "@/media/tree";
import type { LessonImageContent } from "@/content/model";
import { validateLesson } from "@/content/validate";

/**
 * These are behavioural tests on real image bytes: a JPEG carrying EXIF/GPS is
 * actually encoded, the output is re-opened with sharp, and the assertions are
 * about what is inside the file — not about which function was called.
 */

/** Neutral technical fixture: a grid, no curriculum content. */
async function makeJpeg(width = 1600, height = 2200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f5f5f0"/>
    <g stroke="#999" stroke-width="2">${Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 180}" x2="${width}" y2="${i * 180}"/>`).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/** A JPEG whose EXIF block contains a GPS position and a description. */
async function makeGeoTaggedJpeg(width = 800, height = 1000): Promise<Buffer> {
  return sharp(await makeJpeg(width, height))
    .withExif({
      IFD0: { ImageDescription: "phone photo", Make: "TestPhone", Model: "X1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "33/1 30/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "36/1 17/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
}

function exifGpsStrings(buffer: Buffer): string[] {
  // Raw scan for the EXIF marker and GPS tags — independent of sharp's parser,
  // so a regression in the strip cannot hide behind the same library.
  const latin = buffer.toString("latin1");
  const found: string[] = [];
  if (/Exif\0\0/.test(latin)) found.push("Exif header");
  if (/GPSLatitude|GPSLongitude|GPSLatitudeRef/.test(latin)) found.push("GPS tags");
  if (/TestPhone/.test(latin)) found.push("Make");
  return found;
}

describe("processSourceImage — conversion and metadata strip", () => {
  it("converts a JPEG to WebP at both sizes and reports honest dimensions", async () => {
    const source = await makeJpeg(1600, 2200);
    const result = await processSourceImage(source);

    const web = await inspectWebp(result.web);
    const thumb = await inspectWebp(result.thumb);
    expect(web.format).toBe("webp");
    expect(thumb.format).toBe("webp");
    expect(result.width).toBe(1600);
    expect(result.height).toBe(2200);
    expect(web.width).toBe(1600);
    expect(thumb.width).toBeLessThanOrEqual(480);
    expect(result.sha256).toBe(sha256Hex(result.web));
    expect(result.sourceBytes).toBe(source.byteLength);
    // Thumbnail and page are different files.
    expect(result.thumbSha256).not.toBe(result.sha256);
  });

  it("strips GPS and EXIF from a geo-tagged photo (verified on the raw bytes)", async () => {
    const geo = await makeGeoTaggedJpeg();
    // Guard the fixture: the input must really contain what we claim.
    expect(exifGpsStrings(geo).length).toBeGreaterThan(0);

    const result = await processSourceImage(geo);
    for (const buffer of [result.web, result.thumb]) {
      const latin = buffer.toString("latin1");
      expect(latin).not.toMatch(/Exif\0\0/);
      expect(latin).not.toMatch(/GPSLatitude|GPSLongitude|TestPhone/);
      const meta = await sharp(buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
  });

  it("bakes EXIF orientation into the pixels before discarding it", async () => {
    // Orientation 6 = rotate 90° clockwise; after .rotate() width/height swap.
    const source = await sharp(await makeJpeg(600, 900))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await processSourceImage(source);
    expect(result.width).toBeGreaterThan(result.height);
  });

  it("downscales an oversized page but keeps the aspect ratio", async () => {
    const result = await processSourceImage(await makeJpeg(4000, 5000));
    expect(result.width).toBeLessThanOrEqual(2200);
    expect(Math.abs(result.width / result.height - 4000 / 5000)).toBeLessThan(0.01);
  });

  it("does not upscale a small (but legal) image", async () => {
    const result = await processSourceImage(await makeJpeg(400, 500));
    expect(result.width).toBe(400);
    expect(result.height).toBe(500);
  });

  it("rejects a non-image with a stable error code", async () => {
    await expect(processSourceImage(Buffer.from("<html>nope</html>"))).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects an image above the byte limit", async () => {
    const source = await makeJpeg(600, 600);
    await expect(processSourceImage(source, { maxBytes: 100 })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects an image below the minimum dimensions", async () => {
    await expect(processSourceImage(await makeJpeg(40, 40))).rejects.toBeInstanceOf(MediaError);
  });
});

/**
 * The descriptor mechanism itself.
 *
 * `probeNamespace` exercises open, create, stat, child-open and unlink inside a
 * throwaway directory before the namespace is accepted, so a platform whose
 * `readdir` works but whose `open` beneath a descriptor does not is rejected.
 * These tests record what this platform actually supports rather than assuming
 * that the presence of a directory implies the operations work.
 */
/**
 * The media-tree writers and the rollback, under a live swap.
 *
 * Before the descriptor rewrite these called `mkdirSync({recursive:true})` and
 * opened by path, so a swapped component could create, write, delete or restore
 * outside the root. The assertions are the outside tree is untouched, which is
 * the only claim that matters.
 */
/**
 * The temporary file used by `writeJson`.
 *
 * Two defects lived here: the name was `.<leaf>.tmp-<pid>`, so two runs sharing
 * a pid (or one run overlapping itself) collided; and the `catch` unlinked the
 * name unconditionally, so an `EEXIST` failure — meaning the file belonged to
 * someone else — deleted that other file.
 */
describe("writeJson owns only its own temporary file", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-tmp-"));
    root = path.join(base, "content");
    fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("never unlinks a temporary file it did not create", async () => {
    const { writeJson } = await import("@/media/tree");
    const target = path.join(root, "lessons", "1.json");

    // Reproduce a genuine `EEXIST`: a second actor keeps the name occupied. The
    // old scheme used a predictable name, so a colliding writer's file was
    // indistinguishable from our own — and the `catch` deleted it. With a unique
    // name the collision cannot even be aimed at, which is the real fix; this
    // asserts the ownership rule that makes the collision harmless regardless.
    const planted = path.join(root, "lessons", "planted.tmp");
    fs.writeFileSync(planted, "PLANTED");

    // A `Proxy` around the handle would hide the behaviour; instead check the
    // rule directly: a failed write must leave foreign files untouched.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJson(root, target, circular)).toThrow();

    expect(fs.existsSync(planted)).toBe(true);
    expect(fs.readFileSync(planted, "utf8")).toBe("PLANTED");
    // And no `.tmp` of our own survived.
    const leftovers = fs.readdirSync(path.join(root, "lessons")).filter((n) => n.includes(".tmp") && n !== "planted.tmp");
    expect(leftovers).toEqual([]);
  });

  it("gives every call its own temporary name, never the pid-based one", async () => {
    const { writeJson } = await import("@/media/tree");
    const target = path.join(root, "lessons", "1.json");
    // The old fixed name would be predictable: assert it does not exist at all
    // after a successful write, and that a planted file with that name survives.
    const legacy = path.join(root, "lessons", `.1.json.tmp-${process.pid}`);
    fs.writeFileSync(legacy, "LEGACY-PLANTED");

    writeJson(root, target, { id: 1 });

    expect(fs.readFileSync(legacy, "utf8")).toBe("LEGACY-PLANTED");
    expect(JSON.parse(fs.readFileSync(target, "utf8")).id).toBe(1);
  });

  it("uses a unique temporary name per call, so two writers cannot collide", async () => {
    const { writeJson } = await import("@/media/tree");
    const a = path.join(root, "lessons", "1.json");
    const b = path.join(root, "lessons", "2.json");

    // Two concurrent writes to sibling records: neither may delete the other's
    // temporary file, and both must publish.
    await Promise.all([
      Promise.resolve().then(() => writeJson(root, a, { id: 1 })),
      Promise.resolve().then(() => writeJson(root, b, { id: 2 })),
    ]);

    expect(JSON.parse(fs.readFileSync(a, "utf8")).id).toBe(1);
    expect(JSON.parse(fs.readFileSync(b, "utf8")).id).toBe(2);
    // No temporary file survived either publication.
    const leftovers = fs.readdirSync(path.join(root, "lessons")).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("leaves no temporary file behind when the write itself fails", async () => {
    const { writeJson } = await import("@/media/tree");
    const target = path.join(root, "lessons", "3.json");
    // A value that cannot be serialised throws before the rename, with the
    // temporary file already created — exactly the cleanup path.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeJson(root, target, circular)).toThrow();
    const leftovers = fs.readdirSync(path.join(root, "lessons")).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("media tree writes and rollback stay inside their roots", () => {
  let base: string;
  let swapper: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-tree-swap-"));
    swapper = path.join(base, "swapper.cjs");
    fs.writeFileSync(
      swapper,
      `const fs=require("fs"),path=require("path");
       const [target,outside]=process.argv.slice(2);
       for(let i=0;i<90000;i++){
         try{fs.rmSync(target,{recursive:true,force:true});}catch{}
         try{ i%2 ? fs.mkdirSync(target) : fs.symlinkSync(outside,target); }catch{}
       }`,
    );
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function underSwapper<T>(target: string, outside: string, run: () => Promise<T> | T): Promise<T> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [swapper, target, outside], { stdio: "ignore" });
    try {
      return await run();
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }

  it("writeFileInside never writes outside the root", async () => {
    const { writeFileInside } = await import("@/media/tree");
    const root = path.join(base, "media");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "page.webp"), "OUTSIDE-ORIGINAL");

    await underSwapper(path.join(root, "lessons", "5"), outside, async () => {
      for (let i = 0; i < 400; i += 1) {
        try {
          writeFileInside(root, path.join(root, "lessons", "5", "page.webp"), Buffer.from("PAYLOAD"), {
            exclusive: false,
          });
        } catch {
          /* refusals are expected */
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    expect(fs.readFileSync(path.join(outside, "page.webp"), "utf8")).toBe("OUTSIDE-ORIGINAL");
    expect(fs.readdirSync(outside)).toEqual(["page.webp"]);
  }, 60_000);

  it("writeJson never publishes a record outside the root", async () => {
    const { writeJson } = await import("@/media/tree");
    const root = path.join(base, "content");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    await underSwapper(path.join(root, "lessons"), outside, async () => {
      for (let i = 0; i < 300; i += 1) {
        try {
          writeJson(root, path.join(root, "lessons", "1.json"), { id: 1 });
        } catch {
          /* refusals are expected */
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    const leaked = fs.readdirSync(outside, { recursive: true }).filter((entry) => String(entry).endsWith(".json"));
    expect(leaked).toEqual([]);
  }, 60_000);

  it("rollbackWrites never deletes or restores outside the allowed roots", async () => {
    const { rollbackWrites } = await import("@/media/tree");
    const mediaRoot = path.join(base, "media");
    const contentRoot = path.join(base, "content");
    const outside = path.join(base, "outside");
    fs.mkdirSync(path.join(mediaRoot, "lessons"), { recursive: true });
    fs.mkdirSync(contentRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "page.webp"), "OUTSIDE-VICTIM");
    fs.writeFileSync(path.join(outside, "1.json"), "OUTSIDE-RECORD");

    const created = path.join(mediaRoot, "lessons", "page.webp");
    await underSwapper(path.join(mediaRoot, "lessons"), outside, async () => {
      for (let i = 0; i < 300; i += 1) {
        // The path is inside mediaRoot *lexically*; the attacker is moving the
        // directory it names. A rollback may partially undo our own files, but it
        // must never touch the outside ones.
        rollbackWrites(
          [created],
          [{ path: path.join(contentRoot, "1.json"), previous: Buffer.from("RESTORED") }],
          [],
          [mediaRoot, contentRoot],
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    expect(fs.readFileSync(path.join(outside, "page.webp"), "utf8")).toBe("OUTSIDE-VICTIM");
    expect(fs.readFileSync(path.join(outside, "1.json"), "utf8")).toBe("OUTSIDE-RECORD");
  }, 60_000);
});

describe("descriptor-relative primitives work on this platform", () => {
  it("reports whether the platform supports descriptor-relative access", async () => {
    const { supportsDirFd, fdNamespace } = await import("@/lib/dirfd");
    const supported = supportsDirFd();
    // Documented, not asserted blindly: Linux and macOS/BSD are expected to pass,
    // anything else is expected to refuse rather than degrade. The test asserts
    // the *consistency* of the answer on every platform.
    if (supported) {
      expect(["/proc/self/fd", "/dev/fd"]).toContain(fdNamespace());
    } else {
      expect(() => fdNamespace()).toThrow(/descriptor/i);
    }
  });

  it("performs open, create, stat, child-open and unlink through a descriptor", async () => {
    const { openDir } = await import("@/lib/dirfd");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-prims-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "A");
      const h = openDir(dir);
      try {
        expect(h.list().map((e) => e.name)).toEqual(["a.txt"]);
        expect(h.stat("a.txt").isFile()).toBe(true);

        h.mkdir("sub");
        const sub = (await import("@/lib/dirfd")).openDirUnder(h, ["sub"]);
        try {
          h.rename("a.txt", sub, "b.txt");
          expect(sub.list().map((e) => e.name)).toEqual(["b.txt"]);
          const fd = sub.open("b.txt", fs.constants.O_RDONLY);
          try {
            expect(fs.readFileSync(fd, "utf8")).toBe("A");
          } finally {
            fs.closeSync(fd);
          }
          sub.unlink("b.txt");
          expect(sub.list()).toEqual([]);
        } finally {
          sub.close();
        }
      } finally {
        h.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("media reads never cross mediaRoot", () => {
  let root: string;
  let mediaRoot: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "math7-read-guard-"));
    mediaRoot = path.join(root, "public", "media");
    outside = path.join(root, "outside");
    fs.mkdirSync(path.join(mediaRoot, "lessons"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    // A WebP the outside world owns; a read would consume these very bytes.
    fs.writeFileSync(path.join(outside, "secret.webp"), Buffer.from("OUTSIDE-WEBP-BYTES"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to list a lesson directory that is a link out of mediaRoot", () => {
    // lessons/3 is a link; `readdir` would follow it and enumerate outside.
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons", "3"));
    expect(() => listLessonMediaFiles(mediaRoot, 3)).toThrow(UnsafePathError);
  });

  it("refuses to hash a path outside mediaRoot before reading a byte", () => {
    // Prove the refusal precedes the read, not merely that it happens later:
    // the fd is never opened, so a read attempt would show up as a stat/read.
    const victim = path.join(outside, "secret.webp");
    const statBefore = fs.statSync(victim);

    expect(fileSha256(victim, mediaRoot)).toBeNull();

    // Nothing was consumed: same inode, same bytes, same times.
    const statAfter = fs.statSync(victim);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.atimeMs).toBe(statBefore.atimeMs);
    expect(fs.readFileSync(victim).toString()).toBe("OUTSIDE-WEBP-BYTES");
  });

  it("refuses when the lesson folder is a link, before import reads it", async () => {
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons", "3"));
    const source = await makeJpeg(600, 800);

    // The failure is the *read* guard on the listing, not a later write refusal.
    await expect(importImageIntoLesson({ mediaRoot, lessonId: 3, source })).rejects.toBeInstanceOf(
      UnsafePathError,
    );
    expect(fs.readdirSync(outside)).toEqual(["secret.webp"]);
  });

  it("reads bytes from the descriptor, not from a re-resolved path", () => {
    // The distinction matters: `realpath` alone can report an inside path while
    // the descriptor refers to an outside file (swap, open, restore, check). The
    // hash must therefore come from the descriptor and be gated on its identity.
    const dir = path.join(mediaRoot, "lessons", "3");
    fs.mkdirSync(dir, { recursive: true });
    const inside = path.join(dir, "page.webp");
    fs.writeFileSync(inside, Buffer.from("INSIDE"));
    const outsideFile = path.join(outside, "page.webp");
    fs.writeFileSync(outsideFile, Buffer.from("OUTSIDE-SECRET"));

    // Same basename both sides: only the resolved location may decide.
    expect(fileSha256(inside, mediaRoot)).toMatch(/^[0-9a-f]{64}$/);
    expect(fileSha256(outsideFile, mediaRoot)).toBeNull();
  });

  it("still lists and hashes real files inside mediaRoot", () => {
    const dir = path.join(mediaRoot, "lessons", "3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page-01.webp"), Buffer.from("REAL"));

    expect(listLessonMediaFiles(mediaRoot, 3)).toEqual(["page-01.webp"]);
    expect(fileSha256(path.join(dir, "page-01.webp"), mediaRoot)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("importImageIntoLesson — writing to the media tree", () => {
  let mediaRoot: string;

  beforeEach(() => {
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "math7-import-"));
  });
  afterEach(() => {
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  it("writes exactly two files and never the original", async () => {
    const source = await makeGeoTaggedJpeg(1200, 1600);
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 7,
      source,
      label: "page 01",
    });

    expect(result.image.file).toBe("page-01.webp");
    expect(result.image.thumb).toBe("thumbs/page-01.webp");
    expect(result.reused).toBe(false);

    const dir = path.join(mediaRoot, "lessons", "7");
    expect(fs.existsSync(path.join(dir, "page-01.webp"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "thumbs", "page-01.webp"))).toBe(true);
    // The source bytes must exist nowhere in the tree.
    const all = fs.readdirSync(dir, { recursive: true }) as string[];
    expect(all.filter((name) => /\.(jpe?g|png)$/i.test(name))).toEqual([]);
    for (const name of all) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      expect(fs.readFileSync(full)).not.toEqual(source);
    }
    expect(validateLessonImages(result.image).issues).toEqual([]);
  });

  it("is idempotent: re-importing identical content reuses the filename", async () => {
    const source = await makeJpeg(900, 1200);
    const first = await importImageIntoLesson({ mediaRoot, lessonId: 3, source, label: "page 01" });
    const second = await importImageIntoLesson({
      mediaRoot,
      lessonId: 3,
      source,
      label: "page 01",
      existing: [first.image],
    });
    expect(second.reused).toBe(true);
    expect(second.image.file).toBe(first.image.file);
    expect(listLessonMediaFiles(mediaRoot, 3)).toEqual(["page-01.webp"]);
  });

  it("never overwrites a different page with the same label", async () => {
    const a = await importImageIntoLesson({
      mediaRoot,
      lessonId: 4,
      source: await makeJpeg(700, 900),
      label: "page 01",
    });
    const b = await importImageIntoLesson({
      mediaRoot,
      lessonId: 4,
      source: await makeJpeg(701, 900),
      label: "page 01",
      existing: [a.image],
    });
    expect(a.image.file).toBe("page-01.webp");
    expect(b.image.file).toBe("page-01-2.webp");
    expect(b.image.position).toBe(2);
    // Different bytes were preserved in both files.
    const dir = path.join(mediaRoot, "lessons", "4");
    expect(fs.readFileSync(path.join(dir, "page-01.webp"))).not.toEqual(
      fs.readFileSync(path.join(dir, "page-01-2.webp")),
    );
  });

  it("falls back to a positional name for an Arabic-only label", async () => {
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 5,
      source: await makeJpeg(700, 900),
      label: "صفحة ١",
    });
    expect(result.image.file).toBe("page-01.webp");
  });

  it("does not write anything in dry-run mode", async () => {
    const result = await importImageIntoLesson({
      mediaRoot,
      lessonId: 9,
      source: await makeJpeg(700, 900),
      dryRun: true,
    });
    expect(result.image.file).toBe("page-01.webp");
    expect(fs.existsSync(path.join(mediaRoot, "lessons", "9"))).toBe(false);
  });

  it("rejects a path-traversal lesson id", async () => {
    await expect(
      importImageIntoLesson({ mediaRoot, lessonId: Number("../../etc"), source: await makeJpeg(300, 300) }),
    ).rejects.toThrow(/invalid lesson id/);
  });

  it("assigns increasing positions", async () => {
    const existing: LessonImageContent[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await importImageIntoLesson({
        mediaRoot,
        lessonId: 11,
        source: await makeJpeg(300 + index, 300),
        existing,
      });
      existing.push(result.image);
      expect(result.image.position).toBe(index + 1);
    }
    expect(listLessonMediaFiles(mediaRoot, 11)).toEqual(["page-01.webp", "page-02.webp", "page-03.webp"]);
  });
});

/** Runs the imported record through the real content-model validator. */
function validateLessonImages(image: LessonImageContent): { issues: Array<{ code: string }> } {
  const lesson = {
    id: 1,
    unitId: 1,
    position: 1,
    titleAr: "اختبار",
    titleEn: "",
    pageLabel: "",
    status: "draft",
    isLastInUnit: false,
    publishedAt: null,
    contentUpdatedAt: "2026-11-01T10:00:00.000Z",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    images: [image],
  };
  return validateLesson(lesson, "lessons/1.json");
}

describe("importImageIntoLesson — refuses symlink escapes", () => {
  let root: string;
  let mediaRoot: string;
  let outside: string;

  /** Every entry in `outside` with its bytes, so "nothing changed" is provable. */
  function snapshotOutside(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of fs.readdirSync(outside, { withFileTypes: true })) {
      out[entry.name] = entry.isDirectory()
        ? "<dir>"
        : fs.readFileSync(path.join(outside, entry.name)).toString("base64");
    }
    return out;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "math7-import-symlink-"));
    mediaRoot = path.join(root, "public", "media");
    outside = path.join(root, "outside");
    fs.mkdirSync(mediaRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "ORIGINAL-BYTES");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses when mediaRoot/lessons is a symlink out of the root", async () => {
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons"));
    const before = snapshotOutside();
    const source = await makeJpeg(600, 800);

    await expect(importImageIntoLesson({ mediaRoot, lessonId: 3, source })).rejects.toBeInstanceOf(UnsafePathError);

    // Not one file, and not even a lesson directory, appeared outside.
    expect(snapshotOutside()).toEqual(before);
  });

  it("refuses when lessons/<id>/thumbs is a symlink out of the root", async () => {
    fs.mkdirSync(path.join(mediaRoot, "lessons", "3"), { recursive: true });
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons", "3", "thumbs"));
    const before = snapshotOutside();
    const source = await makeJpeg(600, 800);

    await expect(importImageIntoLesson({ mediaRoot, lessonId: 3, source })).rejects.toBeInstanceOf(UnsafePathError);

    // The thumbnail must not have been published outside; the web copy either,
    // because the run must stop before writing anything at all.
    expect(snapshotOutside()).toEqual(before);
    expect(fs.existsSync(path.join(mediaRoot, "lessons", "3", "page-01.webp"))).toBe(false);
  });

  it("refuses when the target WebP itself is a symlink to an outside file", async () => {
    const dir = path.join(mediaRoot, "lessons", "3");
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(outside, "page-01.webp");
    fs.writeFileSync(victim, "OUTSIDE-WEBP");
    fs.symlinkSync(victim, path.join(dir, "page-01.webp"));
    const before = snapshotOutside();
    const source = await makeJpeg(600, 800);

    await expect(importImageIntoLesson({ mediaRoot, lessonId: 3, source })).rejects.toBeInstanceOf(UnsafePathError);

    // The file behind the link kept its bytes, and nothing else appeared.
    expect(snapshotOutside()).toEqual(before);
  });

  it("still writes normally when the tree is clean", async () => {
    const source = await makeJpeg(600, 800);
    const result = await importImageIntoLesson({ mediaRoot, lessonId: 3, source });
    expect(fs.existsSync(result.webPath)).toBe(true);
    expect(fs.existsSync(result.thumbPath)).toBe(true);
    // Nothing leaked into the outside directory.
    expect(fs.readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("protects the shared primitives when called directly", async () => {
    fs.symlinkSync(outside, path.join(mediaRoot, "lessons"));
    expect(() => resolveInside(mediaRoot, path.join(mediaRoot, "lessons", "3", "x.webp"))).toThrow(UnsafePathError);
    expect(() => writeFileInside(mediaRoot, path.join(mediaRoot, "lessons", "3", "x.webp"), Buffer.from("x"))).toThrow(
      UnsafePathError,
    );
    expect(fs.readdirSync(outside)).toEqual(["secret.txt"]);
  });
});

describe("a symlinked media root is usable", () => {
  it("imports into the real directory and validates there", async () => {
    // The root is chosen by the operator and may be a link (a mounted volume,
    // macOS /tmp). The guard must accept both spellings and return the resolved
    // one; an earlier version returned a resolved path that its own callers
    // re-checked against the unresolved root, so every write was rejected.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-linked-media-"));
    const realRoot = path.join(base, "real_media");
    const linkRoot = path.join(base, "media_link");
    fs.mkdirSync(realRoot, { recursive: true });
    fs.symlinkSync(realRoot, linkRoot);
    try {
      const source = await makeJpeg(600, 800);
      const result = await importImageIntoLesson({ mediaRoot: linkRoot, lessonId: 5, source });

      // The returned paths are in the resolved namespace and really exist.
      expect(result.webPath.startsWith(fs.realpathSync(realRoot))).toBe(true);
      expect(fs.existsSync(path.join(realRoot, "lessons", "5", result.image.file))).toBe(true);
      expect(fs.existsSync(path.join(realRoot, "lessons", "5", "thumbs", result.image.file))).toBe(true);
      // A single boundary: nothing was created next to the link.
      expect(fs.readdirSync(base).sort()).toEqual(["media_link", "real_media"]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("writes a lesson record through a symlinked content root", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-linked-content-"));
    const realContent = path.join(base, "real_content");
    const linkContent = path.join(base, "content_link");
    fs.mkdirSync(path.join(realContent, "lessons"), { recursive: true });
    fs.symlinkSync(realContent, linkContent);
    try {
      writeJson(linkContent, path.join(linkContent, "lessons", "1.json"), { id: 1 });
      expect(fs.existsSync(path.join(realContent, "lessons", "1.json"))).toBe(true);
      // ...and a nested directory that had to be created.
      writeJson(linkContent, path.join(linkContent, "lessons", "deep", "2.json"), { id: 2 });
      expect(fs.existsSync(path.join(realContent, "lessons", "deep", "2.json"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("reference tracking — never delete a used image", () => {
  const lessons = [
    {
      id: 1,
      images: [
        { file: "page-01.webp" } as LessonImageContent,
        { file: "page-02.webp" } as LessonImageContent,
      ],
    },
    { id: 2, images: [{ file: "page-01.webp" } as LessonImageContent] },
  ];
  const index = buildReferenceIndex(lessons);

  it("refuses to delete an image a lesson still lists", () => {
    const verdict = checkDeletion({ lessonId: 1, file: "page-01.webp" }, index);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("referenced_by_lesson");
    expect(verdict.detail).toContain("lesson 1");
  });

  it("reports the same filename being used by another lesson, without blocking", () => {
    // lesson 3/page-01.webp does not exist; lessons 1 and 2 both use the name
    // in their own folders. Deleting lesson 3's would-be file is allowed, but
    // the shared name is surfaced so a human can double-check.
    const verdict = checkDeletion({ lessonId: 3, file: "page-01.webp" }, index);
    expect(verdict.allowed).toBe(true);
    expect(verdict.sameNameInLessons).toEqual([1, 2]);
  });

  it("allows deleting an image nothing references", () => {
    const verdict = checkDeletion({ lessonId: 3, file: "page-99.webp" }, index);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("not_referenced");
  });

  it("refuses to delete an image quoted by a quiz question", () => {
    const verdict = checkDeletion({ lessonId: 5, file: "page-42.webp" }, index, [
      { scope: "lesson", lessonId: 5, unitId: null, sourceImages: ["page-42.webp"] },
    ]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("referenced_by_quiz");
    expect(verdict.quizReferences).toBe(1);
  });

  it("refuses illegal names outright rather than normalising them", () => {
    for (const file of ["../page.webp", "Page.webp", "page.png", "a/b.webp"]) {
      const verdict = checkDeletion({ lessonId: 1, file }, index);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe("illegal_name");
    }
  });

  it("collects sourceImage values out of nested quiz JSON", () => {
    const quiz = {
      versions: [
        {
          questions: [
            { sourceImage: "page-01.webp", type: "mcq" },
            { sourceImage: null, type: "essay" },
            { nested: { deeper: [{ sourceImage: "page-03.webp" }] } },
          ],
        },
      ],
    };
    expect(collectQuizSourceImages(quiz).sort()).toEqual(["page-01.webp", "page-03.webp"]);
    expect([...referencedFiles(lessons, [])].sort()).toEqual(["page-01.webp", "page-02.webp"]);
  });
});

/**
 * `rollbackWrites` restore, under a live swap of the entry's name.
 *
 * The restore used to read through one descriptor, close it, and reopen the same
 * *name* for writing without proving it was the same file. A swap in between made
 * the rewrite land on a different file that was never compared.
 */
describe("rollback restore touches only the file it compared", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "math7-restore-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("restores an existing record in place", async () => {
    const { rollbackWrites } = await import("@/media/tree");
    const content = path.join(base, "content");
    const lessons = path.join(content, "lessons");
    fs.mkdirSync(lessons, { recursive: true });
    const target = path.join(lessons, "1.json");
    fs.writeFileSync(target, "NEW-BYTES-THAT-MUST-GO");

    const result = rollbackWrites(
      [],
      [{ path: target, previous: Buffer.from("OLD-BYTES") }],
      [],
      [content],
    );

    expect(result.restored).toBe(1);
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("OLD-BYTES");
  });

  it("recreates a record that vanished instead of failing silently", async () => {
    const { rollbackWrites } = await import("@/media/tree");
    const content = path.join(base, "content");
    const lessons = path.join(content, "lessons");
    fs.mkdirSync(lessons, { recursive: true });
    const target = path.join(lessons, "2.json");

    const result = rollbackWrites([], [{ path: target, previous: Buffer.from("RESTORED") }], [], [content]);

    expect(result.restored).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe("RESTORED");
  });

  it("never rewrites an outside file while the record's name is swapped", async () => {
    const { rollbackWrites } = await import("@/media/tree");
    const content = path.join(base, "content");
    const lessons = path.join(content, "lessons");
    const outside = path.join(base, "outside");
    fs.mkdirSync(lessons, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(lessons, "1.json"), "OURS");
    const victim = path.join(outside, "1.json");
    fs.writeFileSync(victim, "OUTSIDE-VICTIM");
    // The lesson folder now points outside: a restore that follows the name would
    // rewrite the victim.
    fs.rmSync(lessons, { recursive: true, force: true });
    fs.symlinkSync(outside, lessons);

    rollbackWrites([], [{ path: path.join(lessons, "1.json"), previous: Buffer.from("RESTORED") }], [], [
      content,
    ]);

    expect(fs.readFileSync(victim, "utf8")).toBe("OUTSIDE-VICTIM");
  });
});

/**
 * Namespace capability, measured operation by operation.
 *
 * `readdir` succeeding proves almost nothing: a namespace could list a directory
 * while `rename` beneath it fails. The probe therefore exercises open, read,
 * write, mkdir, stat, lstat, unlink, rename between two descriptors, empty-dir
 * removal, and the inode pinning that the whole design depends on. Partial
 * support must be rejected, not tolerated.
 */
describe("the descriptor namespace is proved, not assumed", () => {
  it("supports every operation the module relies on", async () => {
    const { supportsDirFd, fdNamespace } = await import("@/lib/dirfd");
    if (!supportsDirFd()) {
      // Documented outcome on an unsupported platform: refuse, never degrade.
      expect(() => fdNamespace()).toThrow(/descriptor/i);
      return;
    }
    const ns = fdNamespace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-nsprobe-"));
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const base = `${ns}/${fd}`;
      // write + read
      const w = fs.openSync(`${base}/a.txt`, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o644);
      fs.writeFileSync(w, "A");
      fs.closeSync(w);
      const r = fs.openSync(`${base}/a.txt`, fs.constants.O_RDONLY);
      expect(fs.readFileSync(r, "utf8")).toBe("A");
      fs.closeSync(r);
      // stat, lstat
      expect(fs.statSync(`${base}/a.txt`).isFile()).toBe(true);
      expect(fs.lstatSync(`${base}/a.txt`).isSymbolicLink()).toBe(false);
      // mkdir
      fs.mkdirSync(`${base}/sub`);
      const sub = fs.openSync(`${base}/sub`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        // rename between two descriptors
        fs.renameSync(`${base}/a.txt`, `${ns}/${sub}/b.txt`);
        expect(fs.existsSync(`${ns}/${sub}/b.txt`)).toBe(true);
        // unlink
        fs.unlinkSync(`${ns}/${sub}/b.txt`);
        expect(fs.existsSync(`${ns}/${sub}/b.txt`)).toBe(false);
      } finally {
        fs.closeSync(sub);
      }
      // remove an empty directory
      fs.rmdirSync(`${base}/sub`);
      expect(fs.existsSync(path.join(dir, "sub"))).toBe(false);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays pinned to the inode after the path is re-pointed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "math7-pin2-"));
    const moved = `${dir}-moved`;
    fs.writeFileSync(path.join(dir, "a.txt"), "ORIGINAL");
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const ns = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
    try {
      fs.renameSync(dir, moved);
      fs.symlinkSync(os.tmpdir(), dir);
      // Same name, different target: the descriptor must still read the original.
      expect(fs.readFileSync(`${ns}/${fd}/a.txt`, "utf8")).toBe("ORIGINAL");
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(dir);
      fs.renameSync(moved, dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
