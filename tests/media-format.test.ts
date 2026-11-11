import { describe, expect, it } from "vitest";
import {
  ACCEPTED_MIME,
  MAX_IMAGE_EDGE,
  MIN_IMAGE_EDGE,
  checkDimensions,
  detectMime,
  isWebpMagic,
} from "@/media/format";
import {
  MEDIA_FILE_RE,
  canonicalMediaFile,
  isLegalMediaName,
  nextFreeName,
  positionalStem,
  sanitizeBase,
} from "@/media/naming";
import { IMAGE_FILE_RE } from "@/content/model";

describe("media format sniffing", () => {
  it("identifies containers from magic bytes only", async () => {
    const sharp = (await import("sharp")).default;
    const base = await sharp({
      create: { width: 80, height: 80, channels: 3, background: "#eee" },
    })
      .png()
      .toBuffer();
    expect(detectMime(base)).toBe("image/png");
    expect(detectMime(await sharp(base).jpeg().toBuffer())).toBe("image/jpeg");
    expect(detectMime(await sharp(base).webp().toBuffer())).toBe("image/webp");
    expect(isWebpMagic(base)).toBe(false);
  });

  it("rejects text, empty and truncated input instead of guessing", () => {
    expect(detectMime(Buffer.from("<html>not an image</html>"))).toBeNull();
    expect(detectMime(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated JPEG signature
    expect(detectMime(Buffer.alloc(0))).toBeNull();
    expect(detectMime(Buffer.from("RIFF....WAVE"))).toBeNull();
  });

  it("accepts exactly the three documented MIME types", () => {
    expect([...ACCEPTED_MIME]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("image dimension bounds", () => {
  it("rejects images below the minimum edge", () => {
    const problem = checkDimensions(MIN_IMAGE_EDGE - 1, 500);
    expect(problem?.code).toBe("IMAGE_TOO_SMALL");
  });

  it("rejects images above the maximum edge", () => {
    const problem = checkDimensions(MAX_IMAGE_EDGE + 1, 500);
    expect(problem?.code).toBe("IMAGE_TOO_LARGE");
  });

  it("rejects a decompression bomb before decoding", () => {
    const problem = checkDimensions(11_000, 11_000); // 121 MP > 120 MP cap
    expect(problem?.code).toBe("IMAGE_TOO_LARGE");
  });

  it("rejects missing dimensions", () => {
    expect(checkDimensions(undefined, undefined)?.code).toBe("IMAGE_TOO_SMALL");
  });

  it("accepts a normal textbook page", () => {
    expect(checkDimensions(1600, 2200)).toBeNull();
  });
});

describe("filename generation", () => {
  it("agrees with the content model's filename rule", () => {
    // The importer must never produce a name the validator rejects.
    expect(MEDIA_FILE_RE.source).toBe(IMAGE_FILE_RE.source);
  });

  it("sanitises labels into legal names", () => {
    expect(sanitizeBase("Page 01")).toBe("page-01");
    expect(sanitizeBase("Café — Résumé")).toBe("cafe-resume");
    expect(sanitizeBase("  a//b  ")).toBe("a-b");
    expect(sanitizeBase("UPPER_case.png")).toBe("upper-case-png");
  });

  it("refuses labels it cannot make safe", () => {
    expect(sanitizeBase("الدرس الأول")).toBeNull(); // Arabic-only: no ASCII left
    expect(sanitizeBase("///")).toBeNull();
    expect(sanitizeBase("")).toBeNull();
    expect(sanitizeBase("thumbs")).toBeNull(); // would shadow the thumbnail folder
  });

  it("suffixes until the name is free", () => {
    const taken = new Set(["page-01"]);
    expect(nextFreeName("page-01", (name) => taken.has(name.replace(/\.webp$/, "")))).toBe("page-01-2.webp");
  });

  it("keeps long stems inside the limit", () => {
    const longBase = "a".repeat(70);
    const name = nextFreeName(longBase, () => false);
    expect(name.length).toBeLessThanOrEqual(66);
    expect(isLegalMediaName(name)).toBe(true);
  });

  it("produces legal positional stems", () => {
    expect(positionalStem(3)).toBe("page-03");
    expect(positionalStem(12)).toBe("page-12");
    expect(isLegalMediaName(`${positionalStem(99)}.webp`)).toBe(true);
  });

  it("rejects names the model would reject", () => {
    for (const bad of ["Page.webp", "page 1.webp", "../x.webp", "page.png", "-page.webp", "a".repeat(70) + ".webp"]) {
      expect(isLegalMediaName(bad)).toBe(false);
    }
    expect(isLegalMediaName("page-01.webp")).toBe(true);
  });
});

/**
 * The CMS ↔ content-model boundary (NEW-1).
 *
 * Sveltia always stores the asset's *public path* (`/media/lessons/3/page-01.webp`),
 * never a bare name — `getAssetPublicPath()` builds `publicFolder + '/' + name`
 * and returns `undefined` for anything that would not start with `/`. The
 * content model requires a bare name, so `canonicalMediaFile` reconciles the two.
 *
 * These cases pin the parser as a *rejector*: the accepted shapes are a closed
 * list, and a value outside it is refused rather than repaired.
 */
describe("canonicalMediaFile — CMS-written paths → bare names", () => {
  it("accepts every shape Sveltia or media:import can produce", () => {
    expect(canonicalMediaFile("page-01.webp", 3)).toBe("page-01.webp");
    expect(canonicalMediaFile("/media/lessons/3/page-01.webp", 3)).toBe("page-01.webp");
    expect(canonicalMediaFile("public/media/lessons/3/page-01.webp", 3)).toBe("page-01.webp");
    expect(canonicalMediaFile("/public/media/lessons/3/page-01.webp", 3)).toBe("page-01.webp");
    // Two-digit and long ids are fine; the id is compared numerically.
    expect(canonicalMediaFile("/media/lessons/12/page-12.webp", 12)).toBe("page-12.webp");
  });

  it("is idempotent — a canonical value is returned unchanged", () => {
    const once = canonicalMediaFile("/media/lessons/3/page-01.webp", 3)!;
    expect(canonicalMediaFile(once, 3)).toBe(once);
  });

  it("returns the value unchanged when it is already legal", () => {
    for (const legal of ["page-01.webp", "a.webp", "page-999.webp"]) {
      expect(canonicalMediaFile(legal, 3)).toBe(legal);
    }
  });

  it("refuses a path that belongs to a different lesson", () => {
    expect(canonicalMediaFile("/media/lessons/9/page-01.webp", 3)).toBeNull();
    expect(canonicalMediaFile("public/media/lessons/4/page-01.webp", 3)).toBeNull();
    // Leading zeros must not smuggle another folder in.
    expect(canonicalMediaFile("/media/lessons/03/page-01.webp", 3)).toBeNull();
  });

  it("refuses traversal, absolute and encoded forms without repairing them", () => {
    const hostile = [
      "../3/page-01.webp",
      "../../etc/passwd",
      "/media/lessons/3/../../4/page-01.webp",
      "a/../../b.webp",
      "media/lessons/3/page-01.webp",        // no leading slash/known prefix
      "//media/lessons/3/page-01.webp",
      "~/media/lessons/3/page-01.webp",
      "./page-01.webp",
      "@media/lessons/3/page-01.webp",
      "C:\\x\\page-01.webp",
      "%2e%2e%2fpage-01.webp",
      "media/lessons/3/page%2D01.webp",
      "/media/lessons/3/page-01.webp\n",
      "/media/lessons/3/page 01.webp",
      "https://example.com/page-01.webp",
      "data:text/plain;base64,AAAA",
    ];
    for (const value of hostile) {
      expect(canonicalMediaFile(value, 3), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses unsupported extensions instead of renaming them", () => {
    for (const value of [
      "page-01.jpg",
      "page-01.jpeg",
      "page-01.png",
      "page-01.webp.jpg",
      "page-01.WEBP",
      "/media/lessons/3/page-01.jpg",
      "/media/lessons/3/page-01.webp.jpg",
      "page-01",
    ]) {
      expect(canonicalMediaFile(value, 3), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses names the model itself refuses", () => {
    for (const value of ["Page-01.webp", "-page-01.webp", "_page.webp", `${"a".repeat(70)}.webp`]) {
      expect(canonicalMediaFile(value, 3), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuses non-strings and an invalid lesson id", () => {
    for (const value of ["", null, undefined, 42, {}, ["page-01.webp"]]) {
      expect(canonicalMediaFile(value, 3)).toBeNull();
    }
    expect(canonicalMediaFile("page-01.webp", 0)).toBeNull();
    expect(canonicalMediaFile("page-01.webp", 1.5)).toBeNull();
    expect(canonicalMediaFile("page-01.webp", -1)).toBeNull();
  });
});
