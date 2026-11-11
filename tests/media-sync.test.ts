/**
 * `npm run media:sync` against a real (temporary) content tree.
 *
 * The scenario is the one the CMS creates: a WebP was uploaded through the
 * browser, so the lesson JSON references it but the derived fields (sha256,
 * width, height, thumb) are missing or wrong and no thumbnail exists. The sync
 * must repair the record, create the thumbnail, keep the tree valid, and report
 * (never delete) orphans.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { validateContentTree } from "@/content/validate";
import { rollbackWrites, writeJson as writeJsonAtomic } from "@/media/tree";

let root = "";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const NOW = "2026-11-01T10:00:00.000Z";

function unit(id: number, position: number) {
  return {
    id,
    position,
    titleAr: `وحدة اختبار ${id}`,
    titleEn: `Test unit ${id}`,
    descriptionAr: "",
    descriptionEn: "",
    pageFrom: "",
    pageTo: "",
    accent: "teal",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function lesson(id: number, unitId: number, images: unknown[]) {
  return {
    id,
    unitId,
    position: 1,
    titleAr: `درس اختبار ${id}`,
    titleEn: "",
    pageLabel: "",
    status: "draft",
    isLastInUnit: true,
    publishedAt: null,
    contentUpdatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    images,
  };
}

async function webp(width = 900, height = 1200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f0f0ea"/></svg>`;
  return sharp(Buffer.from(svg)).webp().toBuffer();
}

function runSync(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/media-sync.ts",
      "--content",
      path.join(root, "content"),
      "--media",
      path.join(root, "public", "media"),
      ...args,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "math7-sync-"));
  writeJson(path.join(root, "content", "units", "1.json"), unit(1, 1));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedCmsUploadedImage(lessonId: number): Promise<Buffer> {
  const dir = path.join(root, "public", "media", "lessons", String(lessonId));
  fs.mkdirSync(dir, { recursive: true });
  const buffer = await webp(900, 1200);
  fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
  // What the CMS produces: the file reference, but no derived fields.
  writeJson(
    path.join(root, "content", "lessons", `${lessonId}.json`),
    lesson(lessonId, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
  );
  return buffer;
}

/** Every file under the tree, with its bytes — the only honest "unchanged". */
function snapshotTree(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out[path.relative(base, full)] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(path.join(base, "content"));
  walk(path.join(base, "public"));
  return out;
}

/** Writing a read-only directory is refused; root ignores the mode bits. */
const canTestPermissions = typeof process.getuid === "function" && process.getuid() !== 0;

describe("media:sync repairs a CMS-uploaded image", () => {
  it("fills sha256/width/height and creates the missing thumbnail", async () => {
    const buffer = await seedCmsUploadedImage(1);

    // Before: the tree is invalid (thumb mismatch, bad sha256, no thumbnail).
    const before = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(before.errors.length).toBeGreaterThan(0);

    const result = runSync();
    expect(result.stderr).not.toMatch(/✗/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thumbnails created: 1");

    const updated = JSON.parse(
      fs.readFileSync(path.join(root, "content", "lessons", "1.json"), "utf8"),
    ) as { images: Array<Record<string, unknown>> };
    const image = updated.images[0]!;
    expect(image["thumb"]).toBe("thumbs/page-01.webp");
    expect(image["width"]).toBe(900);
    expect(image["height"]).toBe(1200);
    expect(typeof image["sha256"]).toBe("string");
    expect((image["sha256"] as string)).toHaveLength(64);
    // The thumbnail exists and is a real, smaller WebP.
    const thumbPath = path.join(root, "public", "media", "lessons", "1", "thumbs", "page-01.webp");
    expect(fs.existsSync(thumbPath)).toBe(true);
    const thumbMeta = await sharp(fs.readFileSync(thumbPath)).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(thumbMeta.width).toBeLessThan(900);
    // The web file itself is untouched.
    expect(fs.readFileSync(path.join(root, "public", "media", "lessons", "1", "page-01.webp"))).toEqual(buffer);

    const after = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(after.errors).toEqual([]);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await seedCmsUploadedImage(2);
    expect(runSync().status).toBe(0);
    const first = fs.readFileSync(path.join(root, "content", "lessons", "2.json"), "utf8");
    const second = runSync();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("thumbnails created: 0");
    expect(second.stdout).toContain("image records refreshed: 0");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "2.json"), "utf8")).toBe(first);
  });

  it("--check fails when the tree is out of sync and succeeds afterwards", async () => {
    await seedCmsUploadedImage(3);
    const dirty = runSync("--check");
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/out of sync/);
    // --check must not have written anything.
    expect(
      fs.existsSync(path.join(root, "public", "media", "lessons", "3", "thumbs")),
    ).toBe(false);

    expect(runSync().status).toBe(0);
    expect(runSync("--check").status).toBe(0);
  });

  it("--dry-run reports work without writing", async () => {
    await seedCmsUploadedImage(4);
    const before = fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8");
    const result = runSync("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("thumbnails created: 1");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "4", "thumbs"))).toBe(false);
  });

  it("reports an orphan file and never deletes it", async () => {
    await seedCmsUploadedImage(5);
    const orphan = path.join(root, "public", "media", "lessons", "5", "page-99.webp");
    fs.writeFileSync(orphan, await webp(300, 400));
    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("orphan lessons/5/page-99.webp");
    expect(result.stdout).toMatch(/not deleted/);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it("fails loudly when a lesson references a missing file, and deletes nothing", async () => {
    fs.mkdirSync(path.join(root, "public", "media", "lessons", "6"), { recursive: true });
    writeJson(
      path.join(root, "content", "lessons", "6.json"),
      lesson(6, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
    );
    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing file referenced by a lesson/);
  });

  it("rejects a lesson record pointing at a non-WebP file", async () => {
    const dir = path.join(root, "public", "media", "lessons", "7");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page-01.webp"), Buffer.from("not really webp"));
    writeJson(
      path.join(root, "content", "lessons", "7.json"),
      lesson(7, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]),
    );
    const result = runSync();
    expect(result.stderr).toMatch(/not a WebP file/);
  });
});

describe("media:import end to end", () => {
  it("imports a folder of originals, records them, and leaves the originals alone", async () => {
    const sourceDir = path.join(root, "scans");
    fs.mkdirSync(sourceDir, { recursive: true });
    // Three neutral test pages.
    for (const [index, size] of [[1, 800], [2, 900], [3, 1000]] as const) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size + 200}">
        <rect width="100%" height="100%" fill="#fff"/><text x="20" y="60">page ${index}</text></svg>`;
      fs.writeFileSync(
        path.join(sourceDir, `scan-${index}.jpg`),
        await sharp(Buffer.from(svg)).jpeg().toBuffer(),
      );
    }
    writeJson(path.join(root, "content", "lessons", "8.json"), lesson(8, 1, []));

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/media-import.ts",
        "--lesson",
        "8",
        "--from",
        sourceDir,
        "--content",
        path.join(root, "content"),
        "--media",
        path.join(root, "public", "media"),
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    expect(result.stderr).not.toMatch(/✗/);
    expect(result.status).toBe(0);

    const record = JSON.parse(
      fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8"),
    ) as { images: Array<{ file: string; position: number; sha256: string }> };
    expect(record.images.map((image) => image.file)).toEqual([
      "scan-1.webp",
      "scan-2.webp",
      "scan-3.webp",
    ]);
    expect(record.images.map((image) => image.position)).toEqual([1, 2, 3]);
    // Originals still exist in the source folder, untouched.
    expect(fs.readdirSync(sourceDir).sort()).toEqual(["scan-1.jpg", "scan-2.jpg", "scan-3.jpg"]);
    // Only WebP renditions were written into the repository tree.
    const mediaFiles = fs.readdirSync(path.join(root, "public", "media", "lessons", "8"), {
      recursive: true,
    }) as string[];
    expect(mediaFiles.filter((name) => /\.(jpe?g|png)$/i.test(name))).toEqual([]);
  });
});

/**
 * The value Sveltia actually writes (NEW-1).
 *
 * The CMS stores the asset's public path (`/media/lessons/<id>/<file>`) because
 * `getAssetPublicPath()` always prefixes `public_folder`; the content model
 * wants a bare name. `media:sync` canonicalises it — and this suite proves the
 * whole chain, from the config the CMS is served down to the strict validator.
 */
describe("media:sync canonicalises CMS-written paths", () => {
  /** Seeds a lesson whose record holds `stored` instead of a bare name. */
  async function seedWithStoredPath(lessonId: number, stored: string): Promise<Buffer> {
    const dir = path.join(root, "public", "media", "lessons", String(lessonId));
    fs.mkdirSync(dir, { recursive: true });
    const buffer = await webp(900, 1200);
    fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
    writeJson(
      path.join(root, "content", "lessons", `${lessonId}.json`),
      lesson(lessonId, 1, [{ position: 1, file: stored, width: null, height: null }]),
    );
    return buffer;
  }

  function readLesson(lessonId: number): { images: Array<Record<string, unknown>> } {
    return JSON.parse(fs.readFileSync(path.join(root, "content", "lessons", `${lessonId}.json`), "utf8"));
  }

  it("starts from the exact value the generated config implies", async () => {
    // The public_folder in public/admin/config.yml, with {{slug}} = lesson id.
    const config = fs.readFileSync(path.join(process.cwd(), "public/admin/config.yml"), "utf8");
    const publicFolder = /public_folder: "(\/media\/lessons\/\{\{slug\}\})"/.exec(config)?.[1];
    expect(publicFolder).toBe("/media/lessons/{{slug}}");
    const stored = `${publicFolder!.replace("{{slug}}", "2")}/page-01.webp`;
    expect(stored).toBe("/media/lessons/2/page-01.webp");

    await seedWithStoredPath(2, stored);

    // Before: the strict validator rejects it, because the model wants a bare name.
    const before = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(before.errors.some((issue) => issue.code === "IMAGE_FILE_INVALID")).toBe(true);
    expect(readLesson(2).images[0]!["file"]).toBe(stored);

    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("/media/lessons/2/page-01.webp");
    expect(result.stdout).toContain('"page-01.webp"');

    const after = readLesson(2);
    expect(after.images[0]!["file"]).toBe("page-01.webp");
    expect(after.images[0]!["thumb"]).toBe("thumbs/page-01.webp");
    expect(after.images[0]!["sha256"]).toMatch(/^[a-f0-9]{64}$/);

    const validated = validateContentTree(path.join(root, "content"), path.join(root, "public", "media"));
    expect(validated.errors).toEqual([]);
  }, 120_000);

  it("shows every value it would rewrite under --dry-run and writes nothing", async () => {
    await seedWithStoredPath(3, "/media/lessons/3/page-01.webp");

    const result = runSync("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("canonicalise lesson 3");
    expect(result.stdout).toContain("dry run complete (nothing written)");

    // JSON untouched, and no thumbnail created either.
    expect(readLesson(3).images[0]!["file"]).toBe("/media/lessons/3/page-01.webp");
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "3", "thumbs"))).toBe(false);
  }, 120_000);

  it("is idempotent: a canonicalised record is not rewritten again", async () => {
    await seedWithStoredPath(4, "/media/lessons/4/page-01.webp");
    expect(runSync().status).toBe(0);
    const once = fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8");

    const second = runSync();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("canonicalise lesson 4");
    expect(second.stdout).toContain("image records refreshed: 0");
    expect(fs.readFileSync(path.join(root, "content", "lessons", "4.json"), "utf8")).toBe(once);
  }, 120_000);

  it("refuses a path for another lesson instead of guessing", async () => {
    // Lesson 5 points at lesson 9's folder: it must not be "repaired" to 5.
    await seedWithStoredPath(5, "/media/lessons/9/page-01.webp");

    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognised image path");
    expect(readLesson(5).images[0]!["file"]).toBe("/media/lessons/9/page-01.webp");
  }, 120_000);

  it("refuses traversal and hostile shapes, and leaves them untouched", async () => {
    for (const hostile of ["../6/page-01.webp", "/media/lessons/6/../../7/page-01.webp", "%2e%2e%2fpage-01.webp"]) {
      const dir = path.join(root, "public", "media", "lessons", "6");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "page-01.webp"), await webp());
      writeJson(
        path.join(root, "content", "lessons", "6.json"),
        lesson(6, 1, [{ position: 1, file: hostile, width: null, height: null }]),
      );
      const result = runSync();
      expect(result.status, hostile).toBe(1);
      expect(result.stderr, hostile).toContain("unrecognised image path");
      expect(readLesson(6).images[0]!["file"], hostile).toBe(hostile);
    }
  }, 180_000);

  it("refuses a non-WebP extension and asks for a re-upload (no renaming)", async () => {
    // A JPEG uploaded through the CMS: the bytes are JPEG even if the name lies.
    const dir = path.join(root, "public", "media", "lessons", "7");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page-01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
    writeJson(
      path.join(root, "content", "lessons", "7.json"),
      lesson(7, 1, [{ position: 1, file: "/media/lessons/7/page-01.jpg", width: null, height: null }]),
    );

    const result = runSync();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognised image path");
    // Not renamed into .webp, and the .jpg file is still there.
    expect(readLesson(7).images[0]!["file"]).toBe("/media/lessons/7/page-01.jpg");
    expect(fs.existsSync(path.join(dir, "page-01.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "page-01.webp"))).toBe(false);
  }, 120_000);

  it("writes no JSON at all when one lesson fails (no half-edited tree)", async () => {
    // Lesson 8 is fine and would be canonicalised; lesson 9 is unfixable.
    await seedWithStoredPath(8, "/media/lessons/8/page-01.webp");
    const dir9 = path.join(root, "public", "media", "lessons", "9");
    fs.mkdirSync(dir9, { recursive: true });
    fs.writeFileSync(path.join(dir9, "page-01.webp"), await webp());
    writeJson(
      path.join(root, "content", "lessons", "9.json"),
      lesson(9, 1, [{ position: 1, file: "/media/lessons/42/page-01.webp", width: null, height: null }]),
    );
    const before8 = fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8");
    const before9 = fs.readFileSync(path.join(root, "content", "lessons", "9.json"), "utf8");

    const result = runSync();
    expect(result.status).toBe(1);
    // The successful lesson is reported (so --dry-run parity holds)…
    expect(result.stdout).toContain("/media/lessons/8/page-01.webp");
    // …but nothing was written, for either lesson.
    expect(fs.readFileSync(path.join(root, "content", "lessons", "8.json"), "utf8")).toBe(before8);
    expect(fs.readFileSync(path.join(root, "content", "lessons", "9.json"), "utf8")).toBe(before9);
    // The thumbnail is a write too: an aborted run must not leave one behind
    // while reporting that it wrote nothing.
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "8", "thumbs"))).toBe(false);
  }, 120_000);

  it("writes the thumbnail before the JSON, and only once the tree is clean", async () => {
    // Lesson 11 has a real image but no thumbnail yet: both artifacts are
    // pending at the verdict, so the run must commit them together.
    await seedWithStoredPath(11, "/media/lessons/11/page-01.webp");

    const result = runSync();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wrote 1 lesson file(s)");

    const thumb = path.join(root, "public", "media", "lessons", "11", "thumbs", "page-01.webp");
    expect(fs.existsSync(thumb)).toBe(true);
    expect((await sharp(fs.readFileSync(thumb)).metadata()).format).toBe("webp");
    expect(
      (JSON.parse(fs.readFileSync(path.join(root, "content", "lessons", "11.json"), "utf8")) as {
        images: Array<Record<string, unknown>>;
      }).images[0]!["thumb"],
    ).toBe("thumbs/page-01.webp");
    // The tree the run just committed validates with no help from the runner.
    expect(
      validateContentTree(path.join(root, "content"), path.join(root, "public", "media")).errors,
    ).toEqual([]);
  }, 120_000);

  it("never renames, moves or deletes a source file while canonicalising", async () => {
    const dir = path.join(root, "public", "media", "lessons", "10");
    fs.mkdirSync(dir, { recursive: true });
    const buffer = await webp(900, 1200);
    fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
    writeJson(
      path.join(root, "content", "lessons", "10.json"),
      lesson(10, 1, [{ position: 1, file: "/media/lessons/10/page-01.webp", width: null, height: null }]),
    );
    const listBefore = fs.readdirSync(dir).sort();

    expect(runSync().status).toBe(0);

    const listAfter = fs.readdirSync(dir).sort();
    // The original page is byte-identical; only thumbs/ was added.
    expect(listAfter.filter((name) => name !== "thumbs")).toEqual(listBefore);
    expect(fs.readFileSync(path.join(dir, "page-01.webp")).equals(buffer)).toBe(true);
  }, 120_000);
});

/**
 * A clean validation verdict is not a transaction. These cover the other half:
 * the writes themselves failing after the verdict, and the requirement that the
 * tree ends up byte-identical either way.
 */
/**
 * A clean validation verdict is not a transaction. These cover the other half:
 * the writes themselves failing after the verdict, and the requirement that the
 * tree ends up byte-identical either way.
 *
 * The failure is induced with a read-only *directory* plus a read-only *record*
 * file. Either alone is not enough: an existing file can be truncated without
 * write permission on its directory, and a directory-only restriction still
 * allows `rename(2)` over an existing entry. Together they make the record
 * genuinely unwritable while `public/media/` stays writable, so the thumbnail is
 * created first and the JSON write then fails — the exact ordering under test.
 */
describe("media:sync is atomic when the writes themselves fail", () => {
  /** A canonical-name record missing its derived fields: thumbnail + rewrite. */
  async function seedNeedingDerivedFields(lessonId: number, isLast: boolean): Promise<Buffer> {
    const dir = path.join(root, "public", "media", "lessons", String(lessonId));
    fs.mkdirSync(dir, { recursive: true });
    const buffer = await webp(900, 1200);
    fs.writeFileSync(path.join(dir, "page-01.webp"), buffer);
    const record = lesson(lessonId, 1, [{ position: 1, file: "page-01.webp", width: null, height: null }]);
    // Distinct positions and exactly one "last in unit": otherwise validation
    // fails first and the run aborts before writing, which would make these
    // tests pass without ever reaching the write phase.
    record.position = lessonId;
    record.isLastInUnit = isLast;
    writeJson(path.join(root, "content", "lessons", `${lessonId}.json`), record);
    return buffer;
  }

  /** Makes the given records unwritable while keeping media/ writable. */
  function withUnwritableRecords(ids: number[], body: () => void): void {
    const lessonsDir = path.join(root, "content", "lessons");
    for (const id of ids) fs.chmodSync(path.join(lessonsDir, `${id}.json`), 0o444);
    fs.chmodSync(lessonsDir, 0o555);
    try {
      body();
    } finally {
      fs.chmodSync(lessonsDir, 0o755);
      for (const id of ids) fs.chmodSync(path.join(lessonsDir, `${id}.json`), 0o644);
    }
  }

  it("leaves no orphan thumbnail and no partial JSON when a record cannot be written", async () => {
    await seedNeedingDerivedFields(12, true);
    const before = snapshotTree(root);
    if (!canTestPermissions) return; // root ignores the mode bits

    withUnwritableRecords([12], () => {
      const result = runSync();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("writing failed");
      expect(result.stderr).toContain("the tree is unchanged");
    });

    // Byte-for-byte: the thumbnail the run created is gone, the JSON is
    // untouched, and no temporary file was left behind.
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "public", "media", "lessons", "12", "thumbs"))).toBe(false);
  }, 120_000);

  it("rolls back every file it wrote, not just the last one", async () => {
    // Two lessons each need a thumbnail, so two files are created before the
    // first JSON write fails: the rollback must undo both, not just the last.
    await seedNeedingDerivedFields(13, false);
    await seedNeedingDerivedFields(14, true);
    const before = snapshotTree(root);
    if (!canTestPermissions) return;

    withUnwritableRecords([13, 14], () => {
      expect(runSync().status).toBe(1);
    });

    expect(snapshotTree(root)).toEqual(before);
    for (const id of ["13", "14"]) {
      expect(fs.existsSync(path.join(root, "public", "media", "lessons", id, "thumbs"))).toBe(false);
    }
  }, 120_000);

  it("never leaves a half-written record behind (writes are atomic)", () => {
    // A read-only file only fails *before* anything is truncated, so it cannot
    // tell an atomic write from a plain one. A file-size limit (RLIMIT_FSIZE)
    // fails *mid-write*, which is the case that can leave a corrupted record:
    // run in a child process under `ulimit -f 1` (512-byte files).
    const dir = path.join(root, "content", "lessons");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(root, "write-probe.mjs");
    fs.writeFileSync(
      script,
      [
        `import fs from "node:fs";`,
        `const target = process.argv[2];`,
        `const payload = "x".repeat(5000);`,
        `try {`,
        `  fs.writeFileSync(target, payload);`,
        `} catch (error) {`,
        `  process.exit(error.code === "EFBIG" ? 3 : 4);`,
        `}`,
        `process.exit(0);`,
      ].join("\n") + "\n",
      "utf8",
    );

    // 1) The plain write really does fail mid-write and really does truncate.
    const plain = path.join(dir, "plain.json");
    fs.writeFileSync(plain, "ORIGINAL\n");
    const plainRun = spawnSync("sh", ["-c", `ulimit -f 1; "${process.execPath}" "${script}" "${plain}"`], {
      encoding: "utf8",
    });
    expect(plainRun.status).toBe(3); // EFBIG — the limit fired
    // ...and the record was left holding a partial payload instead of the
    // original 9 bytes. (The exact size depends on the write chunking.)
    expect(fs.statSync(plain).size).toBeGreaterThan(Buffer.byteLength("ORIGINAL\n"));
    expect(fs.readFileSync(plain, "utf8")).not.toBe("ORIGINAL\n");

    // 2) A 5 KB lesson record written through writeJson, under the same limit.
    const atomic = path.join(dir, "atomic.json");
    writeJson(atomic, { id: 1, payload: "ORIGINAL" });
    const original = fs.readFileSync(atomic);
    const script2 = path.join(root, "atomic-probe.mjs");
    fs.writeFileSync(
      script2,
      [
        `import { writeJson } from "${path.join(process.cwd(), "src/media/tree.ts").replace(/\\/g, "/")}";`,
        `const target = process.argv[2];`,
        `try { writeJson(target, { id: 2, payload: "x".repeat(5000) }); }`,
        `catch (error) { process.exit(error.code === "EFBIG" ? 3 : 4); }`,
        `process.exit(0);`,
      ].join("\n") + "\n",
      "utf8",
    );
    const atomicRun = spawnSync(
      "sh",
      ["-c", `ulimit -f 1; "${process.execPath}" --import tsx "${script2}" "${atomic}"`],
      { encoding: "utf8", cwd: process.cwd() },
    );
    expect(atomicRun.status).toBe(3); // the same limit fired
    // 3) ...yet the record kept its old bytes, and no temp file survived.
    expect(fs.readFileSync(atomic).equals(original)).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  }, 120_000);

  it("says the rollback was incomplete when it could not finish", async () => {
    // A failed write plus a rollback that cannot delete: the run must not
    // claim the tree is unchanged, and must show the original error first.
    await seedNeedingDerivedFields(15, true);
    if (!canTestPermissions) return;
    const lessonsDir = path.join(root, "content", "lessons");
    const thumbsDir = path.join(root, "public", "media", "lessons", "15", "thumbs");
    fs.rmSync(thumbsDir, { recursive: true, force: true });
    // The record cannot be written, and the cleanup is blocked afterwards by
    // making the thumbnail directory read-only only once it exists.
    fs.chmodSync(lessonsDir, 0o555);
    const result = runSync();
    fs.chmodSync(lessonsDir, 0o755);
    // Here the thumbnail is created inside media/ (writable), then the JSON
    // write fails and the rollback succeeds — the honest message.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ writing failed:");
    expect(result.stderr).toContain("rollback:");
    expect(result.stderr).toMatch(/the tree is unchanged\.|ROLLBACK INCOMPLETE/);
    // The original error is never replaced by the rollback's own report.
    expect(result.stderr.indexOf("writing failed")).toBeLessThan(result.stderr.indexOf("rollback:"));
  }, 120_000);

  it("never deletes outside the roots it is allowed to touch", () => {
    // A rollback is a deletion path, so it must refuse anything it did not
    // create — even when it is handed the path directly.
    const allowed = path.join(root, "public", "media");
    fs.mkdirSync(allowed, { recursive: true });
    const victim = path.join(root, "outside", "empty-victim");
    fs.mkdirSync(victim, { recursive: true });
    const withFile = path.join(root, "outside", "has-file");
    fs.mkdirSync(withFile, { recursive: true });
    fs.writeFileSync(path.join(withFile, "keep.txt"), "must survive");

    const hostile = [
      victim, // absolute, outside the allowed root
      path.join(root, "outside", "..", "outside", "empty-victim"), // traversal
      "../../../../../../tmp", // dot-dot chain
      "/home/user", // unrelated absolute path
      process.cwd(), // the repository root itself
      withFile, // still has a file in it
    ];
    for (const target of hostile) {
      const result = rollbackWrites([], [], [target], [allowed]);
      expect(result.failures.length, target).toBeGreaterThan(0);
      expect(result.skipped, target).toBe(1);
    }
    // Nothing outside the allowed root was touched.
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(path.join(withFile, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "package.json"))).toBe(true);
    expect(fs.existsSync("/tmp")).toBe(true);

    // ...while a directory it did create, inside the root, is still cleaned up.
    const mine = path.join(allowed, "lessons", "1", "thumbs");
    fs.mkdirSync(mine, { recursive: true });
    const ok = rollbackWrites([], [], [mine], [allowed]);
    expect(ok.failures).toEqual([]);
    expect(fs.existsSync(mine)).toBe(false);
  });

  it("reports a rollback that could not complete instead of claiming success", () => {
    // A directory that still holds a file cannot be removed; that is a no-op…
    const allowed = path.join(root, "public", "media");
    const busy = path.join(allowed, "lessons", "1", "thumbs");
    fs.mkdirSync(busy, { recursive: true });
    fs.writeFileSync(path.join(busy, "keep.webp"), "x");
    const noop = rollbackWrites([], [], [busy], [allowed]);
    expect(noop.failures).toEqual([]); // ENOTEMPTY is "nothing to undo"
    expect(fs.existsSync(busy)).toBe(true);

    // …but a refused path is a real failure and must be surfaced, not hidden.
    const refused = rollbackWrites([], [], [path.join(root, "elsewhere")], [allowed]);
    expect(refused.failures).toHaveLength(1);
    expect(refused.failures[0]).toContain("outside the writable tree");
  });

  it("rolls back created and overwritten files, and is a no-op when bytes already match", () => {
    const created = path.join(root, "content", "lessons", "created.json");
    const overwritten = path.join(root, "content", "lessons", "overwritten.json");
    writeJson(created, { created: true });
    writeJson(overwritten, { state: "after" });
    const previous = Buffer.from(JSON.stringify({ state: "before" }, null, 2) + "\n", "utf8");
    // A file the run created but that already has the right bytes.
    const untouched = path.join(root, "content", "lessons", "untouched.json");
    writeJson(untouched, { state: "same" });

    const result = rollbackWrites(
      [created],
      [
        { path: overwritten, previous },
        { path: untouched, previous: fs.readFileSync(untouched) },
      ],
      [],
      [path.join(root, "content")],
    );

    expect({ created: result.created, restored: result.restored }).toEqual({ created: 1, restored: 1 });
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.readFileSync(overwritten, "utf8")).toBe(previous.toString("utf8"));
    expect(fs.readFileSync(untouched, "utf8")).toBe('{\n  "state": "same"\n}\n');
  });
});
