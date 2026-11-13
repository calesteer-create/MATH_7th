import { useTranslations } from "next-intl";
import { CONTACT_PHONE_LOCAL, WHATSAPP_URL } from "@/lib/contact";
import { cx } from "@/lib/utils";

/**
 * Fixed WhatsApp contact bars (top and bottom).
 *
 * LAYOUT CONTRACT — see `.contact-*` utilities in src/app/globals.css:
 *   - The top bar is NOT `fixed`. It lives inside the sticky stack built by
 *     SiteShell (contact bar + site header), so it is always visible without
 *     ever covering the header, the mobile menu, or page content.
 *   - The bottom bar IS `fixed`. SiteShell reserves its height with
 *     `.contact-reserve`, so the footer and the last lesson navigation button
 *     can always be scrolled fully into view above it.
 *   - Stacking order: skip link (z-50) > sticky header stack (z-40) > fixed
 *     bottom bar (z-30) > page content. An open mobile menu therefore paints
 *     over the bottom bar on short viewports, and any future modal can sit
 *     above everything by using z-50 or higher.
 *
 * Both bars are a single full-width anchor: the whole strip is the tap target,
 * which matters on a phone. The number is isolated (`dir="ltr"`) so it reads
 * left-to-right inside an RTL sentence, and the icon is inline SVG — no CDN,
 * no network request, nothing for the Pages artifact audit to reject.
 */

/** Official WhatsApp glyph (simple-icons, CC0), inlined — no external asset. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

export function ContactBar({ position }: { position: "top" | "bottom" }) {
  const t = useTranslations("contact");
  const isTop = position === "top";

  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("ariaLabel")}
      className={cx("group block w-full", isTop ? "contact-bar-top" : "contact-bar-bottom")}
    >
      {isTop ? (
        <span className="mx-auto flex h-full max-w-6xl items-center justify-center gap-2 px-4 sm:gap-2.5 sm:px-6">
          <WhatsAppIcon className="size-4 shrink-0 text-whatsapp-bright" />
          <span className="truncate text-xs font-semibold text-mist sm:text-sm">{t("name")}</span>
          <span aria-hidden className="size-1 shrink-0 rounded-full bg-faint/70" />
          <span dir="ltr" className="bidi-isolate shrink-0 text-xs text-muted sm:text-sm">
            {CONTACT_PHONE_LOCAL}
          </span>
          <span className="hidden shrink-0 rounded-full border border-whatsapp/35 bg-whatsapp/12 px-2.5 py-0.5 text-xs font-medium text-whatsapp-bright transition-colors group-hover:bg-whatsapp/20 sm:inline-flex">
            {t("cta")}
          </span>
        </span>
      ) : (
        <span className="mx-auto flex h-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-whatsapp/15 text-whatsapp-bright ring-1 ring-whatsapp/30 transition-colors group-hover:bg-whatsapp/25"
          >
            <WhatsAppIcon className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="truncate text-sm font-semibold text-mist">{t("name")}</span>
            <span dir="ltr" className="bidi-isolate truncate text-xs text-muted">
              {CONTACT_PHONE_LOCAL}
            </span>
          </span>
          <span className="ms-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-whatsapp px-3.5 py-2 text-xs font-bold text-ink-950 transition-colors group-hover:bg-whatsapp-bright">
            <WhatsAppIcon className="size-4 sm:hidden" />
            <span className="sm:hidden">{t("shortCta")}</span>
            <span className="hidden sm:inline">{t("cta")}</span>
          </span>
        </span>
      )}
    </a>
  );
}
