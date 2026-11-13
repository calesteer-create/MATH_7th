/**
 * Phase 1 — fixed WhatsApp contact bars and the brighter design tokens.
 *
 * Three layers are verified here:
 *
 *   1. `src/lib/contact.ts` — the number → wa.me derivation, which is the one
 *      place a wrong country code or a stray "+" would silently break every
 *      contact link on the site.
 *   2. The rendered bars in both locales — real React server rendering, so the
 *      href, the security attributes, the bidi isolation and the translated
 *      label are asserted on actual markup, not on source text.
 *   3. The layout contract in globals.css — the fixed bottom bar must have its
 *      height reserved, must sit below the header stack, and must use logical
 *      properties so it mirrors in RTL. Plus the contrast ratios that the
 *      "brighter but still readable" requirement actually means.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { ContactBar } from "@/components/contact-bar";
import {
  CONTACT_COUNTRY_CODE,
  CONTACT_PHONE_INTERNATIONAL,
  CONTACT_PHONE_LOCAL,
  WHATSAPP_URL,
  toWhatsAppNumber,
} from "@/lib/contact";
import ar from "@/i18n/messages/ar.json";
import en from "@/i18n/messages/en.json";

const ROOT = process.cwd();
const CSS = fs.readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");

function render(position: "top" | "bottom", locale: "ar" | "en"): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "ar" ? ar : en,
      timeZone: "Asia/Damascus",
      children: createElement(ContactBar, { position }),
    }),
  );
}

/** Relative luminance per WCAG 2.x, on an sRGB hex colour. */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) =>
    v! <= 0.03928 ? v! / 12.92 : Math.pow((v! + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Read a `--color-*` / `--contact-*` token straight out of the stylesheet. */
function token(name: string): string {
  const m = CSS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found in globals.css`);
  return m[1]!.trim();
}

// ── 1. number derivation ───────────────────────────────────────────────────

describe("contact number → wa.me", () => {
  it("publishes the owner's local number unchanged", () => {
    expect(CONTACT_PHONE_LOCAL).toBe("0930215022");
    expect(CONTACT_COUNTRY_CODE).toBe("963");
  });

  it("drops the trunk zero and prefixes Syria's code", () => {
    expect(toWhatsAppNumber("0930215022")).toBe("963930215022");
    expect(CONTACT_PHONE_INTERNATIONAL).toBe("963930215022");
  });

  it("builds the official click-to-chat URL with digits only", () => {
    expect(WHATSAPP_URL).toBe("https://wa.me/963930215022");
    expect(WHATSAPP_URL).toMatch(/^https:\/\/wa\.me\/\d+$/);
  });

  it("ignores display formatting (spaces, dashes, parentheses)", () => {
    expect(toWhatsAppNumber("0930 215 022")).toBe("963930215022");
    expect(toWhatsAppNumber("0930-215-022")).toBe("963930215022");
    expect(toWhatsAppNumber("(0930) 215 022")).toBe("963930215022");
  });

  it("does not double the country code when it is already present", () => {
    expect(toWhatsAppNumber("963930215022")).toBe("963930215022");
    expect(toWhatsAppNumber("+963 930 215 022")).toBe("963930215022");
    expect(toWhatsAppNumber("00963930215022")).toBe("963930215022");
  });

  it("strips every leading trunk zero, not just one", () => {
    expect(toWhatsAppNumber("00930215022")).toBe("963930215022");
  });

  it("never emits a plus, a space or a dash", () => {
    for (const input of ["0930215022", "+963 930 215 022", "0930-215-022"]) {
      expect(toWhatsAppNumber(input)).toMatch(/^\d+$/);
    }
  });
});

// ── 2. rendered bars ───────────────────────────────────────────────────────

describe("contact bars — rendered markup", () => {
  for (const locale of ["ar", "en"] as const) {
    for (const position of ["top", "bottom"] as const) {
      const html = render(position, locale);

      it(`${locale}/${position}: links to the one official WhatsApp URL`, () => {
        expect(html).toContain(`href="${WHATSAPP_URL}"`);
        // Exactly one tap target per bar — the whole strip is the link.
        expect(html.match(/<a\b/g)).toHaveLength(1);
      });

      it(`${locale}/${position}: opens safely in a new tab`, () => {
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
      });

      it(`${locale}/${position}: carries a translated accessible label`, () => {
        const label = locale === "ar" ? ar.contact.ariaLabel : en.contact.ariaLabel;
        expect(html).toContain(`aria-label="${label}"`);
        expect(label).toContain(CONTACT_PHONE_LOCAL);
      });

      it(`${locale}/${position}: shows the owner's name and local number`, () => {
        const name = locale === "ar" ? ar.contact.name : en.contact.name;
        expect(html).toContain(name);
        expect(html).toContain(CONTACT_PHONE_LOCAL);
      });

      it(`${locale}/${position}: isolates the number for bidi correctness`, () => {
        // The digits must not reorder inside an Arabic sentence.
        expect(html).toMatch(/dir="ltr"[^>]*class="[^"]*bidi-isolate/);
      });

      it(`${locale}/${position}: uses the position-specific layout class`, () => {
        expect(html).toContain(`contact-bar-${position}`);
        expect(html).not.toContain(`contact-bar-${position === "top" ? "bottom" : "top"}`);
      });

      it(`${locale}/${position}: inlines the icon instead of fetching an asset`, () => {
        expect(html).toContain("<svg");
        expect(html).toContain('aria-hidden="true"');
        expect(html).not.toMatch(/<img\b/);
        expect(html).not.toMatch(/https?:\/\/(?!wa\.me)/);
      });
    }
  }

  it("renders the top bar in flow and the bottom bar fixed (via CSS classes)", () => {
    expect(render("top", "ar")).toContain("contact-bar-top");
    expect(render("bottom", "ar")).toContain("contact-bar-bottom");
    // The top bar must not be fixed: it lives inside the sticky header stack.
    expect(CSS).not.toMatch(/\.contact-bar-top\s*\{[^}]*position:\s*fixed/);
    expect(CSS).toMatch(/\.contact-bar-bottom\s*\{[^}]*position:\s*fixed/);
  });

  it("keeps the Arabic name intact and never machine-translates it", () => {
    expect(ar.contact.name).toBe("المهندس سومر شاهين");
    expect(render("top", "ar")).toContain("المهندس سومر شاهين");
  });
});

// ── 3. layout + contrast contract ──────────────────────────────────────────

describe("contact bar layout contract", () => {
  it("reserves the fixed bottom bar's height so it cannot cover content", () => {
    const bar = CSS.match(/\.contact-bar-bottom\s*\{([^}]*)\}/)![1]!;
    const reserve = CSS.match(/\.contact-reserve\s*\{([^}]*)\}/)![1]!;
    expect(bar).toMatch(/block-size:\s*calc\(var\(--contact-bottom-h\)\s*\+\s*env\(safe-area-inset-bottom/);
    expect(reserve).toMatch(/padding-block-end:\s*calc\(var\(--contact-bottom-h\)\s*\+\s*env\(safe-area-inset-bottom/);
  });

  it("accounts for the device safe area on both the bar and the reservation", () => {
    expect(CSS.match(/\.contact-bar-bottom\s*\{([^}]*)\}/)![1]).toContain("env(safe-area-inset-bottom");
    expect(CSS.match(/\.contact-reserve\s*\{([^}]*)\}/)![1]).toContain("env(safe-area-inset-bottom");
  });

  it("anchors the bottom bar with logical inset properties only", () => {
    const bar = CSS.match(/\.contact-bar-bottom\s*\{([^}]*)\}/)![1]!;
    expect(bar).toContain("inset-inline:");
    expect(bar).toContain("inset-block-end:");
    expect(bar).not.toMatch(/\b(?:left|right)\s*:/);
  });

  it("stacks the bars below the header so an open menu is never clipped", () => {
    const barZ = Number(CSS.match(/\.contact-bar-bottom\s*\{[^}]*z-index:\s*(\d+)/)![1]);
    const shell = fs.readFileSync(path.join(ROOT, "src", "components", "site-shell.tsx"), "utf8");
    const headerZ = Number(shell.match(/sticky top-0 z-(\d+)/)![1]);
    expect(barZ).toBeLessThan(headerZ);
    // …and the skip link stays above both.
    const skipZ = Number(shell.match(/focus:z-(\d+)/)![1]);
    expect(skipZ).toBeGreaterThan(headerZ);
  });

  it("keeps the header out of its own sticky context inside the shared stack", () => {
    const header = fs.readFileSync(path.join(ROOT, "src", "components", "site-header.tsx"), "utf8");
    const tag = header.match(/<header className="([^"]*)"/)![1]!;
    expect(tag).not.toContain("sticky");
  });

  it("mounts both bars around the page content in the shell", () => {
    const shell = fs.readFileSync(path.join(ROOT, "src", "components", "site-shell.tsx"), "utf8");
    expect(shell).toContain('<ContactBar position="top" />');
    expect(shell).toContain('<ContactBar position="bottom" />');
    expect(shell).toContain('className="contact-reserve"');
    // The reserved wrapper must contain main and the footer, not the fixed bar.
    const reserveBlock = shell.slice(shell.indexOf('className="contact-reserve"'));
    expect(reserveBlock.indexOf("<main")).toBeLessThan(reserveBlock.indexOf("<SiteFooter"));
    expect(reserveBlock.indexOf("<SiteFooter")).toBeLessThan(reserveBlock.indexOf('<ContactBar position="bottom"'));
  });

  it("offsets anchor jumps so #main lands below the sticky stack", () => {
    expect(CSS).toMatch(/scroll-padding-block-start:\s*calc\(var\(--contact-top-h\)/);
    expect(CSS).toMatch(/scroll-padding-block-end:\s*calc\(var\(--contact-bottom-h\)/);
  });

  it("defines both bar heights as tokens", () => {
    expect(token("contact-top-h")).toMatch(/^\d/);
    expect(token("contact-bottom-h")).toMatch(/^\d/);
  });
});

describe("brighter palette stays readable", () => {
  const bg = token("color-ink-950");
  const card = token("color-ink-800");

  it("lifts the page surface off near-black", () => {
    // The old background was #05080f; the new one must be measurably brighter.
    expect(luminance(bg)).toBeGreaterThan(luminance("#05080f"));
  });

  it("keeps every text token at AA (≥4.5:1) on both page and card surfaces", () => {
    for (const name of ["color-mist", "color-muted", "color-faint"]) {
      const value = token(name);
      expect(contrast(value, bg), `${name} on page`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(value, card), `${name} on card`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps body text at AAA (≥7:1) on the page surface", () => {
    expect(contrast(token("color-mist"), bg)).toBeGreaterThanOrEqual(7);
    expect(contrast(token("color-muted"), bg)).toBeGreaterThanOrEqual(7);
  });

  it("keeps button label text readable on every filled button colour", () => {
    const ink = token("color-ink-950");
    for (const name of ["color-brand-400", "color-brand-500", "color-whatsapp", "color-whatsapp-bright"]) {
      expect(contrast(ink, token(name)), `ink on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the WhatsApp accent and every unit accent readable on a card", () => {
    for (const name of [
      "color-whatsapp-bright",
      "color-unit-teal",
      "color-unit-sky",
      "color-unit-indigo",
      "color-unit-violet",
      "color-unit-rose",
      "color-unit-amber",
      "color-unit-emerald",
      "color-unit-cyan",
    ]) {
      expect(contrast(token(name), card), `${name} on card`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("emits the unit accents unconditionally so inline var() lookups resolve", () => {
    // The unit accents are consumed as `var(--color-unit-<accent>)` inside
    // inline styles, which Tailwind's utility scanner cannot see. A plain
    // `@theme` tree-shakes them and every accent silently falls back to
    // white; `@theme static` is what keeps them in the compiled stylesheet.
    const staticBlock = CSS.match(/@theme static\s*\{([^}]*)\}/);
    expect(staticBlock, "@theme static block is missing").not.toBeNull();
    for (const accent of ["teal", "sky", "indigo", "violet", "rose", "amber", "emerald", "cyan"]) {
      expect(staticBlock![1], `--color-unit-${accent}`).toContain(`--color-unit-${accent}:`);
    }
  });

  it("stays a dark theme (no accidental light-mode flip)", () => {
    expect(CSS).toContain("color-scheme: dark");
    expect(luminance(bg)).toBeLessThan(0.05);
  });

  it("keeps the reduced-motion escape hatch intact", () => {
    expect(CSS).toContain("prefers-reduced-motion: reduce");
  });
});

describe("contact translations", () => {
  it("exists in both locales with the same keys", () => {
    expect(Object.keys(ar.contact).sort()).toEqual(Object.keys(en.contact).sort());
  });

  it("has no empty string in either locale", () => {
    for (const messages of [ar, en]) {
      for (const [key, value] of Object.entries(messages.contact)) {
        expect(value.trim(), key).not.toBe("");
      }
    }
  });

  it("states the number in the accessible label in both languages", () => {
    expect(ar.contact.ariaLabel).toContain(CONTACT_PHONE_LOCAL);
    expect(en.contact.ariaLabel).toContain(CONTACT_PHONE_LOCAL);
  });

  it("warns screen-reader users that the link opens a new tab", () => {
    expect(ar.contact.ariaLabel).toContain("تبويب جديد");
    expect(en.contact.ariaLabel).toContain("new tab");
  });
});
