import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { Badge } from "@/components/ui/primitives";
import { getSessionUser } from "@/lib/auth";
import { formatCount } from "@/lib/format";
import { overviewStats } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AdminOverview({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);

  const t = await getTranslations({ locale, namespace: "admin.overview" });
  const l = locale as "ar" | "en";
  const stats = overviewStats();
  const aiConfigured = Boolean(process.env.QUIZ_PROVIDER && process.env.QUIZ_API_KEY);

  const cards = [
    { label: t("units"), value: stats.units },
    { label: t("lessons"), value: stats.lessons },
    { label: t("published"), value: stats.published },
    { label: t("drafts"), value: stats.drafts },
    { label: t("images"), value: stats.images },
  ];

  return (
    <AdminShell locale={locale} active="overview" title={t("title")}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="card-surface rounded-2xl p-5">
            <p className="bidi-isolate text-3xl font-black text-mist">{formatCount(c.value, l)}</p>
            <p className="mt-1 text-xs text-faint">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6">
        {aiConfigured ? (
          <div className="card-surface flex items-center gap-3 rounded-2xl p-5">
            <Badge tone="success">●</Badge>
            <p className="text-sm text-mist">{t("aiConfigured")}</p>
          </div>
        ) : (
          <div className="card-surface rounded-2xl border-amber-400/25 p-5">
            <div className="flex items-center gap-3">
              <Badge tone="warn">●</Badge>
              <p className="text-sm font-medium text-amber-200">{t("aiMissing")}</p>
            </div>
            <p className="mt-2 text-xs text-muted">
              <code className="bidi-isolate rounded bg-white/5 px-1.5 py-0.5">{t("configureAi")}</code>
            </p>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
