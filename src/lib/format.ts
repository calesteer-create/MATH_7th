/**
 * Number and date formatting — the single permitted path.
 *
 * WHY THIS FILE EXISTS
 * `new Intl.NumberFormat("ar")` defaults to the `latn` numbering system, but
 * `new Intl.NumberFormat("ar-SY")` defaults to `arab` (١٢٣٤٥٦٧٨٩). A Syrian
 * product using the obvious locale tag would silently render Eastern
 * Arabic-Indic digits everywhere. The platform requires Western digits
 * 0123456789 in BOTH languages, so `numberingSystem: "latn"` is hard-coded here
 * and raw Intl / toLocale* calls are banned by ESLint.
 */

export type FormatLocale = "ar" | "en";

const NUMBERING_SYSTEM = "latn" as const;

export function formatNumber(
  value: number,
  locale: FormatLocale,
  options: Omit<Intl.NumberFormatOptions, "numberingSystem"> = {},
): string {
  return new Intl.NumberFormat(locale, { ...options, numberingSystem: NUMBERING_SYSTEM }).format(
    value,
  );
}

/** Digits only, no grouping separators — for page numbers, counters, indices. */
export function formatCount(value: number, locale: FormatLocale): string {
  return formatNumber(value, locale, { useGrouping: false, maximumFractionDigits: 0 });
}

export function formatDate(
  iso: string | Date,
  locale: FormatLocale,
  timeZone: string = process.env.TIME_ZONE ?? "Asia/Damascus",
): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale, {
    calendar: "gregory",
    numberingSystem: NUMBERING_SYSTEM,
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(
  iso: string | Date,
  locale: FormatLocale,
  timeZone: string = process.env.TIME_ZONE ?? "Asia/Damascus",
): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale, {
    calendar: "gregory",
    numberingSystem: NUMBERING_SYSTEM,
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Wraps formatted output in an isolating span class. Verified necessary: even
 * Intl's own percent output embeds invisible U+200E bidi marks, and neutral
 * characters such as digits inherit direction from their context.
 */
export const BIDI_ISOLATE_CLASS = "bidi-isolate";

/** Latin-script tokens embedded in Arabic prose (URLs, abbreviations). */
export function embedLtr(value: string): string {
  return `\u2066${value}\u2069`;
}
