import { defineRouting } from "next-intl/routing";

/**
 * Arabic is the default language; English is a complete second language.
 * Direction is *derived* from the locale — never authored per page — so RTL and
 * LTR cannot drift apart. See `dirFor` below: the single source of truth.
 */
export const routing = defineRouting({
  locales: ["ar", "en"] as const,
  defaultLocale: "ar",
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];

const RTL_LOCALES: ReadonlySet<string> = new Set(["ar"]);

/** The only place in the codebase that decides text direction. */
export function dirFor(locale: string): "rtl" | "ltr" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

export function isRtl(locale: string): boolean {
  return dirFor(locale) === "rtl";
}
