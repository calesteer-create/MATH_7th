import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  computeSourceFingerprint,
  type LessonContent,
  type UnitContent,
} from "@/content/model";
import { validateContentTree, validateUnit } from "@/content/validate";

/**
 * The integrated reference example under tests/content/example is the exact
 * shape the publish pipeline will validate before anything reaches the public
 * repo: two units (one with lessons), one published lesson, one draft lesson
 * flagged as last-in-unit, real WebP fixtures on disk, and a quiz exercising
 * the future generation schema. It is NOT curriculum content.
 */
const EXAMPLE = path.join(process.cwd(), "tests", "content", "example");
const EXAMPLE_CONTENT = path.join(EXAMPLE, "content");
const EXAMPLE_MEDIA = path.join(EXAMPLE, "media");

function exampleLesson(id: number): LessonContent {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLE_CONTENT, "lessons", `${id}.json`), "utf8"));
}
function exampleUnit(id: number): UnitContent {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLE_CONTENT, "units", `${id}.json`), "utf8"));
}

function codes(result: { errors: Array<{ code: string }>; warnings: Array<{ code: string }> }): string[] {
  return [...result.errors, ...result.warnings].map((i) => i.code);
}

/* ── the reference example validates clean, end to end ─────────────────── */

describe("reference example tree", () => {
  it("validates with zero errors and zero warnings", () => {
    const result = validateContentTree(EXAMPLE_CONTENT, EXAMPLE_MEDIA);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect({ ...result.stats, mediaBytes: 0 }).toEqual({
      units: 2,
      lessons: 2,
      publishedLessons: 1,
      draftLessons: 1,
      images: 2,
      quizzes: 1,
      mediaBytes: 0,
    });
    expect(result.stats.mediaBytes).toBeGreaterThan(0);
  });

  it("the quiz fingerprint matches the lesson images (staleness detection works)", () => {
    const quiz = JSON.parse(
      fs.readFileSync(path.join(EXAMPLE_CONTENT, "quizzes", "lesson-1.json"), "utf8"),
    ) as { sourceFingerprint: string };
    expect(quiz.sourceFingerprint).toBe(computeSourceFingerprint(exampleLesson(1).images));
  });

  it("the fingerprint changes when an image is replaced and not when order changes", () => {
    const images = exampleLesson(1).images;
    const same = computeSourceFingerprint([...images].reverse());
    expect(same).toBe(computeSourceFingerprint(images));
    const replaced = images.map((img) => (img.position === 1 ? { ...img, sha256: "0".repeat(64) } : img));
    expect(computeSourceFingerprint(replaced)).not.toBe(computeSourceFingerprint(images));
  });
});

/* ── tree-level rules, exercised against mutated copies ────────────────── */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "math7-content-"));
  fs.cpSync(EXAMPLE_CONTENT, path.join(tmp, "content"), { recursive: true });
  fs.cpSync(EXAMPLE_MEDIA, path.join(tmp, "media"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tree(mutate?: () => void): ReturnType<typeof validateContentTree> {
  if (mutate) mutate();
  return validateContentTree(path.join(tmp, "content"), path.join(tmp, "media"));
}
function patchJson(rel: string, patch: (value: Record<string, unknown>) => void): void {
  const file = path.join(tmp, "content", rel);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> &
    Record<string, unknown>;
  patch(value);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe("unit validation", () => {
  it("rejects an empty Arabic title", () => {
    patchJson("units/1.json", (u) => (u.titleAr = "   "));
    expect(codes(tree())).toContain("MISSING_FIELD");
  });

  it("rejects a title longer than 200 characters", () => {
    patchJson("units/1.json", (u) => (u.titleAr = "و".repeat(201)));
    expect(codes(tree())).toContain("STRING_TOO_LONG");
  });

  it("rejects an unknown accent colour", () => {
    patchJson("units/1.json", (u) => (u.accent = "banana"));
    expect(codes(tree())).toContain("ACCENT_UNKNOWN");
  });

  it("rejects a duplicate position across units", () => {
    patchJson("units/2.json", (u) => (u.position = 1));
    expect(codes(tree())).toContain("DUPLICATE_UNIT_POSITION");
  });

  it("rejects a filename that disagrees with the declared id", () => {
    fs.renameSync(path.join(tmp, "content", "units", "1.json"), path.join(tmp, "content", "units", "3.json"));
    const result = tree();
    expect(result.errors.some((i) => i.code === "FILE_ID_MISMATCH")).toBe(true);
  });

  it("rejects unknown fields (typos cannot drift silently)", () => {
    patchJson("units/1.json", (u) => (u.titelAr = "تائه"));
    expect(codes(tree())).toContain("UNKNOWN_FIELD");
  });

  it("rejects a non-ISO timestamp", () => {
    patchJson("units/1.json", (u) => (u.updatedAt = "أمس تقريبًا"));
    expect(codes(tree())).toContain("INVALID_ISO_DATE");
  });
});

describe("lesson validation", () => {
  it("rejects a lesson whose unit does not exist", () => {
    patchJson("lessons/1.json", (l) => (l.unitId = 999));
    expect(codes(tree())).toContain("UNIT_NOT_FOUND");
  });

  it("rejects two lessons flagged as the last of one unit", () => {
    patchJson("lessons/1.json", (l) => (l.isLastInUnit = true));
    expect(codes(tree())).toContain("LAST_IN_UNIT_DUPLICATE");
  });

  it("rejects duplicate positions inside one unit", () => {
    patchJson("lessons/2.json", (l) => (l.position = 1));
    expect(codes(tree())).toContain("DUPLICATE_LESSON_POSITION");
  });

  it("requires images on a published lesson", () => {
    patchJson("lessons/1.json", (l) => (l.images = []));
    expect(codes(tree())).toContain("PUBLISHED_NEEDS_IMAGES");
  });

  it("requires publishedAt on a published lesson", () => {
    patchJson("lessons/1.json", (l) => (l.publishedAt = null));
    expect(codes(tree())).toContain("PUBLISHED_NEEDS_PUBLISHED_AT");
  });

  it("rejects a traversal-y image file name", () => {
    patchJson("lessons/1.json", (l) => {
      const images = l.images as Array<Record<string, unknown>>;
      images[0]!.file = "../../escape.webp";
    });
    expect(codes(tree())).toContain("IMAGE_FILE_INVALID");
  });

  it("rejects a thumbnail that is not derived from the file name", () => {
    patchJson("lessons/1.json", (l) => {
      const images = l.images as Array<Record<string, unknown>>;
      images[0]!.thumb = "thumbs/other.webp";
    });
    expect(codes(tree())).toContain("IMAGE_THUMB_MISMATCH");
  });

  it("rejects a sha256 that is not lowercase hex", () => {
    patchJson("lessons/1.json", (l) => {
      const images = l.images as Array<Record<string, unknown>>;
      images[0]!.sha256 = "ZZZ".repeat(22).slice(0, 64);
    });
    expect(codes(tree())).toContain("IMAGE_SHA256_INVALID");
  });

  it("rejects duplicate image positions", () => {
    patchJson("lessons/1.json", (l) => {
      const images = l.images as Array<Record<string, unknown>>;
      images[1]!.position = 1;
    });
    expect(codes(tree())).toContain("IMAGE_POSITION_DUPLICATE");
  });

  it("fails when a referenced media file is missing on disk", () => {
    fs.rmSync(path.join(tmp, "media", "lessons", "1", "page-02.webp"));
    expect(codes(tree())).toContain("IMAGE_NOT_FOUND");
  });

  /**
   * Guard, not a regression: `30d763f` already refused this case, because the
   * `isInsideRoot` check ran before the read. The change makes the refusal
   * structural — the bytes now come from a pinned descriptor rather than from a
   * path that was checked a moment earlier. So this test does not distinguish the
   * two versions; it locks the behaviour in place for future changes.
   */
  it("refuses to read a media file that lives outside the root through a link", () => {
    // `content:validate` hashes media to prove the record matches the bytes. If it
    // follows a symlinked lesson folder it hashes a file that is not part of the
    // repository — a record could then "validate" against bytes nobody reviewed,
    // and an outside file would be opened by a validation run.
    const outside = path.join(tmp, "outside-media");
    fs.mkdirSync(outside, { recursive: true });
    const realBytes = fs.readFileSync(path.join(tmp, "media", "lessons", "1", "page-01.webp"));
    fs.writeFileSync(path.join(outside, "page-01.webp"), realBytes);
    // Re-point the lesson folder at the outside copy.
    const lessonDir = path.join(tmp, "media", "lessons", "1");
    fs.rmSync(lessonDir, { recursive: true, force: true });
    fs.symlinkSync(outside, lessonDir);

    // The page exists through the link, so a path-based read would find it and
    // accept the record. The descriptor read refuses the component instead.
    const result = tree();
    expect(codes(result)).toContain("IMAGE_NOT_FOUND");
    // And the outside bytes were not consumed: the file is untouched.
    expect(fs.readFileSync(path.join(outside, "page-01.webp"))).toEqual(realBytes);
  });

  it("fails when a media file's hash does not match the lesson record", () => {
    const file = path.join(tmp, "media", "lessons", "1", "page-01.webp");
    const buf = fs.readFileSync(file);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    fs.writeFileSync(file, buf);
    expect(codes(tree())).toContain("IMAGE_HASH_MISMATCH");
  });

  it("fails when a .webp file is not actually a WebP", () => {
    const file = path.join(tmp, "media", "lessons", "1", "page-01.webp");
    fs.writeFileSync(file, Buffer.from("definitely not a webp container"));
    expect(codes(tree())).toContain("IMAGE_NOT_WEBP");
  });

  it("warns about media files no lesson references", () => {
    fs.copyFileSync(
      path.join(tmp, "media", "lessons", "1", "page-01.webp"),
      path.join(tmp, "media", "lessons", "1", "orphan-01.webp"),
    );
    const result = tree();
    expect(result.warnings.some((i) => i.code === "IMAGE_ORPHAN")).toBe(true);
  });
});

describe("quiz validation", () => {
  it("rejects a filename/scope mismatch", () => {
    patchJson("quizzes/lesson-1.json", (q) => (q.scope = "unit"));
    expect(codes(tree())).toContain("QUIZ_SCOPE_MISMATCH");
  });

  it("rejects both lessonId and unitId being set", () => {
    patchJson("quizzes/lesson-1.json", (q) => (q.unitId = 1));
    expect(codes(tree())).toContain("QUIZ_TARGET_INVALID");
  });

  it("rejects a quiz whose lesson does not exist", () => {
    patchJson("quizzes/lesson-1.json", (q) => (q.lessonId = 999));
    fs.renameSync(
      path.join(tmp, "content", "quizzes", "lesson-1.json"),
      path.join(tmp, "content", "quizzes", "lesson-999.json"),
    );
    const result = tree();
    expect(result.errors.some((i) => i.code === "QUIZ_TARGET_NOT_FOUND")).toBe(true);
  });

  it("rejects an activeVersion with no matching versionNumber", () => {
    patchJson("quizzes/lesson-1.json", (q) => (q.activeVersion = 99));
    expect(codes(tree())).toContain("QUIZ_ACTIVE_VERSION_INVALID");
  });

  it("rejects duplicate version numbers", () => {
    patchJson("quizzes/lesson-1.json", (q) => {
      const versions = q.versions as Array<Record<string, unknown>>;
      versions.push({ ...versions[0], versionNumber: 1 });
    });
    expect(codes(tree())).toContain("QUIZ_VERSION_DUPLICATE");
  });

  it("rejects duplicate question positions", () => {
    patchJson("quizzes/lesson-1.json", (q) => {
      const versions = q.versions as Array<{ questions: Array<Record<string, unknown>> }>;
      versions[0]!.questions[1]!.position = 1;
    });
    expect(codes(tree())).toContain("QUIZ_QUESTION_POSITION_DUPLICATE");
  });

  it("rejects an unknown gradingMode", () => {
    patchJson("quizzes/lesson-1.json", (q) => {
      const versions = q.versions as Array<{ questions: Array<Record<string, unknown>> }>;
      versions[0]!.questions[0]!.gradingMode = "vibes";
    });
    expect(codes(tree())).toContain("GRADING_MODE_INVALID");
  });

  it("rejects a question source image outside the assessed lesson", () => {
    patchJson("quizzes/lesson-1.json", (q) => {
      const versions = q.versions as Array<{ questions: Array<Record<string, unknown>> }>;
      versions[0]!.questions[0]!.sourceImage = "page-99.webp";
    });
    expect(codes(tree())).toContain("SOURCE_IMAGE_NOT_FOUND");
  });

  it("rejects a malformed fingerprint", () => {
    patchJson("quizzes/lesson-1.json", (q) => (q.sourceFingerprint = "not-a-hash"));
    expect(codes(tree())).toContain("QUIZ_FINGERPRINT_INVALID");
  });

  it("warns (not fails) when the quiz went stale after an image change", () => {
    const file = path.join(tmp, "media", "lessons", "1", "page-01.webp");
    const buf = fs.readFileSync(file);
    buf[10] = buf[10]! ^ 0x01;
    fs.writeFileSync(file, buf);
    // recompute the record-side hash so the only remaining signal is staleness
    patchJson("lessons/1.json", (l) => {
      const images = l.images as Array<Record<string, unknown>>;
      images[0]!.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    });
    const result = tree();
    expect(result.errors.filter((i) => i.code === "IMAGE_HASH_MISMATCH")).toEqual([]);
    expect(result.warnings.some((i) => i.code === "QUIZ_SOURCE_STALE")).toBe(true);
  });
});

describe("empty tree", () => {
  it("a fresh checkout with no content validates cleanly with zero stats", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "math7-empty-"));
    try {
      fs.mkdirSync(path.join(empty, "content", "units"), { recursive: true });
      fs.mkdirSync(path.join(empty, "content", "lessons"), { recursive: true });
      fs.mkdirSync(path.join(empty, "content", "quizzes"), { recursive: true });
      const result = validateContentTree(path.join(empty, "content"), path.join(empty, "media"));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.stats).toEqual({
        units: 0,
        lessons: 0,
        publishedLessons: 0,
        draftLessons: 0,
        images: 0,
        quizzes: 0,
        mediaBytes: 0,
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("canonical filenames and duplicate targets", () => {
  it("rejects a leading-zero unit filename instead of aliasing id 1", () => {
    fs.writeFileSync(
      path.join(tmp, "content", "units", "01.json"),
      fs.readFileSync(path.join(tmp, "content", "units", "2.json")),
    );
    const result = tree();
    expect(result.errors.some((i) => i.code === "FILENAME_NOT_CANONICAL" && i.path.includes("01.json"))).toBe(true);
    // 01.json declares id 2, so this is an id collision with the real 2.json, not a silent swap
    expect(result.errors.some((i) => i.code === "DUPLICATE_ID")).toBe(true);
  });

  it("rejects a leading-zero lesson filename", () => {
    fs.writeFileSync(
      path.join(tmp, "content", "lessons", "01.json"),
      fs.readFileSync(path.join(tmp, "content", "lessons", "1.json")),
    );
    const result = tree();
    expect(result.errors.some((i) => i.code === "FILENAME_NOT_CANONICAL" && i.path.includes("01.json"))).toBe(true);
    expect(result.errors.some((i) => i.code === "DUPLICATE_ID")).toBe(true);
  });

  it("rejects two quizzes for the same lesson even across filename spellings", () => {
    fs.copyFileSync(
      path.join(tmp, "content", "quizzes", "lesson-1.json"),
      path.join(tmp, "content", "quizzes", "lesson-01.json"),
    );
    const result = tree();
    expect(result.errors.some((i) => i.code === "FILENAME_NOT_CANONICAL" && i.path.includes("lesson-01.json"))).toBe(true);
    expect(result.errors.some((i) => i.code === "QUIZ_DUPLICATE_TARGET" && i.message.includes("lesson 1"))).toBe(true);
  });

  it("rejects a leading-zero quiz filename on its own", () => {
    fs.renameSync(
      path.join(tmp, "content", "quizzes", "lesson-1.json"),
      path.join(tmp, "content", "quizzes", "lesson-01.json"),
    );
    expect(codes(tree())).toContain("FILENAME_NOT_CANONICAL");
  });

  it("keeps the first record and reports both files on an id collision (never drops silently)", () => {
    fs.writeFileSync(
      path.join(tmp, "content", "units", "01.json"),
      fs.readFileSync(path.join(tmp, "content", "units", "2.json")),
    );
    const result = tree();
    const duplicate = result.errors.find((i) => i.code === "DUPLICATE_ID");
    expect(duplicate).toBeDefined();
    expect(duplicate!.message).toContain("2.json");
    expect(duplicate!.message).toContain("01.json");
    // the canonical record still participates in the tree (cross-checks still run)
    expect(result.stats.units).toBe(2);
  });

  it("canonical filenames pass without the new codes", () => {
    const result = tree();
    expect(result.errors.filter((i) => i.code === "FILENAME_NOT_CANONICAL")).toEqual([]);
    expect(result.errors.filter((i) => i.code === "QUIZ_DUPLICATE_TARGET")).toEqual([]);
    expect(result.errors.filter((i) => i.code === "DUPLICATE_ID")).toEqual([]);
  });
});

describe("validateUnit (unit seeded shape)", () => {
  it("defaults a missing accent to teal", () => {
    const raw = { ...exampleUnit(1) } as Record<string, unknown>;
    delete raw.accent;
    const { value, issues } = validateUnit(raw, "units/1.json");
    expect(issues).toEqual([]);
    expect(value?.accent).toBe("teal");
  });
});

/**
 * Defence in depth for the media reads (validate.ts).
 *
 * Today `IMAGE_FILE_RE` makes an escaping name impossible — no separators, no
 * dots before `.webp` — so the containment guard never fires. That is exactly
 * why it is worth pinning: the safety of `path.join(mediaRoot, "lessons", id,
 * file)` must not rest on a regex in a different module. The guard is also
 * checked for over-eagerness, so a legal record still validates cleanly.
 */
describe("media containment guard", () => {
  const NOW = "2026-11-01T10:00:00.000Z";
  let guardRoot = "";

  function seed(file: string, thumbSha: string): { content: string; media: string } {
    const content = path.join(guardRoot, "content");
    const media = path.join(guardRoot, "public", "media");
    const write = (target: string, value: unknown) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(value, null, 2));
    };
    write(path.join(content, "units", "1.json"), {
      id: 1, position: 1, titleAr: "وحدة", titleEn: "U",
      descriptionAr: "", descriptionEn: "", pageFrom: "", pageTo: "",
      accent: "teal", createdAt: NOW, updatedAt: NOW,
    });
    write(path.join(content, "lessons", "1.json"), {
      id: 1, unitId: 1, position: 1, titleAr: "درس", titleEn: "", pageLabel: "",
      status: "draft", isLastInUnit: false, publishedAt: null,
      contentUpdatedAt: NOW, createdAt: NOW, updatedAt: NOW,
      images: [{ position: 1, file: "page-01.webp", thumb: "thumbs/page-01.webp", sha256: thumbSha }],
    });
    void file;
    return { content, media };
  }

  beforeEach(() => {
    guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "math7-guard-"));
  });

  afterEach(() => {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  });

  it("still reports a missing media root rather than throwing", () => {
    const { content } = seed("lessons/1/page-01.webp", "a".repeat(64));
    const result = validateContentTree(content, path.join(guardRoot, "no-such-media"));
    expect(result.warnings.some((issue) => issue.code === "MEDIA_ROOT_MISSING")).toBe(true);
  });

  it("validates a legal record on disk with no errors (guard is not over-eager)", async () => {
    const sharp = (await import("sharp")).default;
    const buffer = await sharp({
      create: { width: 40, height: 60, channels: 3, background: "#eeeeee" },
    })
      .webp()
      .toBuffer();
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    const { content, media } = seed("lessons/1/page-01.webp", digest);
    fs.mkdirSync(path.join(media, "lessons", "1", "thumbs"), { recursive: true });
    fs.writeFileSync(path.join(media, "lessons", "1", "page-01.webp"), buffer);
    fs.writeFileSync(path.join(media, "lessons", "1", "thumbs", "page-01.webp"), buffer);

    const result = validateContentTree(content, media);
    expect(result.errors).toEqual([]);
  });
});
