import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { cx } from "@/lib/utils";
import { LogoutButton } from "./logout-button";
import { LocaleSwitcher } from "@/components/locale-switcher";

export async function AdminShell({
  locale,
  active,
  title,
  actions,
  children,
}: {
  locale: string;
  active: "overview" | "units" | "lessons" | "quizzes";
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "admin.nav" });

  const items = [
    { key: "overview" as const, href: "/admin" as const, label: t("overview") },
    { key: "units" as const, href: "/admin/units" as const, label: t("units") },
    { key: "lessons" as const, href: "/admin/lessons" as const, label: t("lessons") },
    { key: "quizzes" as const, href: "/admin/quizzes" as const, label: t("quizzes") },
  ];

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-ink-950/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-xs font-black text-ink-950">
              7
            </span>
            <span className="hidden text-sm font-bold text-mist sm:block">{t("overview")}</span>
          </Link>

          <nav aria-label="Admin" className="mx-auto flex items-center gap-1 overflow-x-auto">
            {items.map((i) => (
              <Link
                key={i.key}
                href={i.href}
                className={cx(
                  "whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors",
                  active === i.key ? "bg-white/[0.07] text-mist" : "text-muted hover:text-mist",
                )}
              >
                {i.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <LocaleSwitcher />
            <Link
              href="/"
              className="hidden rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:text-mist sm:block"
            >
              {t("viewSite")}
            </Link>
            <LogoutButton label={t("logout")} locale={locale} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-mist">{title}</h1>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
