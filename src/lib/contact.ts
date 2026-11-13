/**
 * Public WhatsApp contact — single source of truth.
 *
 * The owner publishes one local Syrian number. Every contact surface (the two
 * fixed bars today, any future footer or help link) must derive its href from
 * here so the international form can never drift from the displayed one.
 *
 * This module is deliberately pure and dependency-free: it is imported by
 * server components, client components and tests alike, and it must stay safe
 * to include in the static export. It contains no secret — the number is
 * published intentionally by the owner.
 */

/** Syria's country calling code, without "+" (wa.me wants digits only). */
export const CONTACT_COUNTRY_CODE = "963";

/** The local number exactly as the owner writes it, with the trunk prefix. */
export const CONTACT_PHONE_LOCAL = "0930215022";

/**
 * Local Syrian number → wa.me digits.
 *
 * Rules, in order:
 *   1. keep digits only (spaces, dashes, "+" and parentheses are display noise);
 *   2. drop the `00` international access prefix if present, so `00963…` is
 *      recognised as already international rather than trunk-prefixed;
 *   3. a number already carrying the country code is returned unchanged;
 *   4. otherwise drop the leading trunk zero(s) and prefix the country code.
 *
 * `0930215022` → `963930215022`. Never returns "+", spaces or dashes: wa.me
 * rejects them, and a malformed link fails silently in the browser.
 */
export function toWhatsAppNumber(
  local: string,
  countryCode: string = CONTACT_COUNTRY_CODE,
): string {
  const digits = local.replace(/\D/g, "").replace(/^00/, "");
  const country = countryCode.replace(/\D/g, "");
  if (digits.startsWith(country)) return digits;
  return `${country}${digits.replace(/^0+/, "")}`;
}

/** International form, digits only — e.g. "963930215022". */
export const CONTACT_PHONE_INTERNATIONAL = toWhatsAppNumber(CONTACT_PHONE_LOCAL);

/** The one official click-to-chat URL used across the site. */
export const WHATSAPP_URL = `https://wa.me/${CONTACT_PHONE_INTERNATIONAL}`;
