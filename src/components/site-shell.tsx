import { setRequestLocale } from "next-intl/server";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";
import { ContactBar } from "./contact-bar";

/**
 * Public page shell.
 *
 * The sticky stack holds the top contact bar and the site header together, so
 * they move as one unit: the bar can never slide over the navigation, and the
 * mobile menu still opens directly beneath the header. The bottom contact bar
 * is fixed, and `.contact-reserve` pads the page by exactly its height (plus
 * the device safe-area inset) so the footer and the last lesson navigation
 * button always remain reachable above it.
 */
export async function SiteShell({
  locale,
  children,
}: {
  locale: string;
  children: React.ReactNode;
}) {
  setRequestLocale(locale);
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-ink-950"
      >
        ·
      </a>
      <div className="contact-reserve">
        <div className="sticky top-0 z-40">
          <ContactBar position="top" />
          <SiteHeader />
        </div>
        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
          {children}
        </main>
        <SiteFooter />
      </div>
      <ContactBar position="bottom" />
    </>
  );
}
