import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LoginSubmit } from "@/components/admin/login-submit";
import { getSessionUser, hasOwnerAccount } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "admin.login" });
  const tn = await getTranslations({ locale, namespace: "nav" });

  if (await getSessionUser()) redirect("/admin");

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-black text-ink-950">
              7
            </span>
            <span className="text-base font-bold text-mist">
              MATH<span className="text-brand-400">7TH</span>
            </span>
          </span>
          <LocaleSwitcher />
        </div>

        <div className="card-surface rounded-[var(--radius-card)] p-7">
          <h1 className="text-xl font-bold text-mist">{t("title")}</h1>
          <p className="mt-1.5 text-sm text-muted">{t("subtitle")}</p>

          {!hasOwnerAccount() ? (
            <p className="mt-5 rounded-xl border border-amber-400/25 bg-amber-400/8 p-3.5 text-xs leading-relaxed text-amber-200">
              {t("notConfigured")}
            </p>
          ) : null}

          <LoginSubmit
            locale={locale}
            hasError={error === "1"}
            labels={{
              username: t("username"),
              password: t("password"),
              submit: t("submit"),
              error: t("error"),
            }}
          />

          <div className="mt-6 border-t border-line-soft pt-4">
            <a href={`/${locale}`} className="text-xs text-muted hover:text-mist">
              ← {tn("home")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
