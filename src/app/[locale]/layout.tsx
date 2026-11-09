import type { Metadata } from "next";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { dirFor, routing } from "@/i18n/routing";
import { BASE_PATH } from "@/lib/base-path";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: { default: t("title"), template: `%s — ${t("title")}` },
    description: t("description"),
    // Prefixed with BASE_PATH so the exported hreflang links point at
    // /MATH_7th/ar … on GitHub Pages instead of the domain root.
    alternates: { languages: { ar: `${BASE_PATH}/ar`, en: `${BASE_PATH}/en` } },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    // Direction is derived from the locale here and nowhere else, so the Arabic
    // interface is RTL-native and the English one LTR-native by construction.
    <html lang={locale} dir={dirFor(locale)} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 grain opacity-30" />
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
