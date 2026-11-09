import { setRequestLocale } from "next-intl/server";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";

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
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
