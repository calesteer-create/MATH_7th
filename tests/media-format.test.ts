import { describe, expect, it } from "vitest";
import {
  ACCEPTED_MIME,
  MAX_IMAGE_EDGE,
  MIN_IMAGE_EDGE,
  checkDimensions,
  detectMime,
  isWebpMagic,
} from "@/media/format";
import { MEDIA_FILE_RE, isLegalMediaName, nextFreeName, positionalStem, sanitizeBase } from "@/media/naming";
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
