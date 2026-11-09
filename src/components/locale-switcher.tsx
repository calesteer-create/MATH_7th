"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cx } from "@/lib/utils";

/**
 * Language switcher, present on every page including sign-in.
 *
 * Swapping locale swaps `dir` on <html> via the layout — the layout below is the
 * only place direction is decided, so this control cannot produce a
 * half-mirrored page.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const next = locale === "ar" ? "en" : "ar";

  return (
    <button
      type="button"
      onClick={() => {
        router.replace(pathname, { locale: next });
      }}
      aria-label={locale === "ar" ? "Switch language to English" : "تبديل اللغة إلى العربية"}
      className={cx(
        "inline-flex h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3",
        "text-sm text-muted transition-colors hover:border-brand-500/50 hover:text-mist",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" fill="none" className="size-4" aria-hidden>
        <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2.75 10h14.5M10 2.75c2 2 2 12.5 0 14.5M10 2.75c-2 2-2 12.5 0 14.5" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span className="font-medium">{next === "ar" ? "العربية" : "English"}</span>
    </button>
  );
}
