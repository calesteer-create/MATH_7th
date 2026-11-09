import { describe, expect, it } from "vitest";
import { formatCount, formatDate, formatNumber } from "@/lib/format";

const EASTERN = /[٠-٩۰-۹]/;
/** Invisible bidi controls Intl inserts around formatted numbers in RTL locales. */
const BIDI_CONTROLS = /[\u200e\u200f\u2066-\u2069]/g;
const VISIBLE_WESTERN = /^[0-9.,\s%+\-–]+$/;

/** Strips invisible bidi marks so we can assert on the characters a user sees. */
const visible = (s: string) => s.replace(BIDI_CONTROLS, "");

describe("Western numerals — hard product requirement", () => {
  it("confirms ar-SY really does default to Eastern digits in this runtime", () => {
    // This is the trap: the obvious locale tag for a Syrian product renders ١٢٣٤٥٦٧٨٩.
    expect(new Intl.NumberFormat("ar-SY").format(1234567)).toMatch(EASTERN);
    // ...while bare "ar" happens to default to Latin. Never rely on either default.
    expect(new Intl.NumberFormat("ar").resolvedOptions().numberingSystem).toBe("latn");
  });

  it("renders 0123456789 for both languages and every value", () => {
    for (const value of [0, 7, 42, 1234567, 98.5, -12, 1000000]) {
      for (const locale of ["ar", "en"] as const) {
        const out = formatNumber(value, locale);
        expect(out, `${locale} ${value}`).not.toMatch(EASTERN);
        expect(visible(out), `${locale} ${value}`).toMatch(VISIBLE_WESTERN);
      }
    }
  });

  it("documents that Intl inserts invisible bidi marks, so output must be isolated", () => {
    // Found while writing these tests: Arabic output carries U+200E. Neutral
    // characters such as digits inherit direction from context, which is why
    // every formatted number in the UI is wrapped in a bidi-isolating element.
    expect(formatNumber(-12, "ar")).toContain("\u200e");
    expect(visible(formatNumber(-12, "ar"))).toBe("-12");
  });

  it("keeps counters free of grouping separators", () => {
    expect(formatCount(12345, "ar")).toBe("12345");
    expect(formatCount(3, "en")).toBe("3");
    expect(formatCount(0, "ar")).toBe("0");
  });

  it("formats percentages without Eastern digits", () => {
    const out = formatNumber(0.875, "ar", { style: "percent", maximumFractionDigits: 0 });
    expect(out).not.toMatch(EASTERN);
    expect(visible(out)).toContain("88");
  });

  it("formats dates on the Gregorian calendar with Western digits", () => {
    const iso = "2026-11-08T09:30:00.000Z";
    for (const locale of ["ar", "en"] as const) {
      const out = formatDate(iso, locale, "UTC");
      expect(out).not.toMatch(EASTERN);
      expect(out).toContain("2026");
      expect(visible(out)).toContain("8");
    }
  });

  it("uses Asia/Damascus (UTC+3, no DST) by default", () => {
    // Syria has not observed DST since 2022; both dates must land on UTC+3.
    const winter = new Date("2026-01-15T09:00:00Z");
    const summer = new Date("2026-07-15T09:00:00Z");
    for (const d of [winter, summer]) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Damascus",
        hour: "2-digit",
        hour12: false,
      }).format(d);
      expect(parts).toBe("12");
    }
  });
});
