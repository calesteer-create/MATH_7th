"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cx } from "@/lib/utils";
import { LocaleSwitcher } from "./locale-switcher";

export function SiteHeader() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = [
    { href: "/" as const, label: t("home"), match: (p: string) => p === "/" },
    { href: "/units" as const, label: t("units"), match: (p: string) => p.startsWith("/units") || p.startsWith("/lessons") },
    { href: "/quizzes/lessons" as const, label: t("lessonQuizzes"), match: (p: string) => p.startsWith("/quizzes/lessons") },
    { href: "/quizzes/units" as const, label: t("unitQuizzes"), match: (p: string) => p.startsWith("/quizzes/units") },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-line-soft bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <span
            aria-hidden
            className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-black text-ink-950"
          >
            7
          </span>
          <span className="text-base font-bold tracking-tight text-mist">
            MATH<span className="text-brand-400">7TH</span>
          </span>
        </Link>

        <nav aria-label="Main" className="mx-auto hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cx(
                "rounded-lg px-3.5 py-2 text-sm transition-colors",
                l.match(pathname) ? "bg-white/[0.06] text-mist" : "text-muted hover:text-mist",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-2 md:ms-0">
          <LocaleSwitcher />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? t("closeMenu") : t("openMenu")}
            className="grid size-9 place-items-center rounded-lg border border-white/10 text-muted transition-colors hover:text-mist md:hidden"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 10h14M3 14h14" />}
            </svg>
          </button>
        </div>
      </div>

      {open ? (
        <nav aria-label="Mobile" className="border-t border-line-soft px-4 py-3 md:hidden">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={cx(
                "block rounded-lg px-3 py-2.5 text-sm",
                l.match(pathname) ? "bg-white/[0.06] text-mist" : "text-muted",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
