import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { UnitForm } from "@/components/admin/unit-form";
import { ReorderRow } from "@/components/admin/reorder-row";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/lib/auth";
import { formatCount } from "@/lib/format";
import { listUnits } from "@/lib/queries";
import { createUnitAction } from "../actions";
import { Ar } from "@/components/ui/ar-text";

export const dynamic = "force-dynamic";

export default async function AdminUnits({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);

  const t = await getTranslations({ locale, namespace: "admin.units" });
  const l = locale as "ar" | "en";
  const units = listUnits();

  return (
    <AdminShell locale={locale} active="units" title={t("title")}>
      <section className="card-surface mb-8 rounded-[var(--radius-card)] p-6">
        <h2 className="mb-5 text-lg font-bold text-mist">{t("new")}</h2>
        <UnitForm locale={locale} action={createUnitAction} submitLabel={t("create")} />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-bold text-mist">{t("title")}</h2>
        {units.length === 0 ? (
          <EmptyState title={t("empty")} body={t("empty")} />
        ) : (
          <ol className="grid gap-2">
            {units.map((unit, i) => (
              <li key={unit.id}>
                <div
                  className="card-surface flex items-center gap-3 rounded-2xl p-4"
                  style={{ ["--accent" as string]: `var(--color-unit-${unit.accent})` }}
                >
                  <ReorderRow
                    index={i}
                    total={units.length}
                    ids={units.map((u) => u.id)}
                    action="reorderUnits"
                    upLabel={t("moveUp")}
                    downLabel={t("moveDown")}
                  />
                  <span
                    aria-hidden
                    className="bidi-isolate grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]"
                  >
                    {formatCount(i + 1, l)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-mist"><Ar>{unit.titleAr}</Ar></span>
                    {unit.titleEn ? (
                      <span dir="ltr" className="block truncate text-xs text-faint">
                        {unit.titleEn}
                      </span>
                    ) : null}
                  </span>
                  <Badge tone="neutral">{t("lessonsCount")}: {formatCount(unit.lessonCount, l)}</Badge>
                  <Link
                    href={`/admin/units/${unit.id}`}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted transition-colors hover:text-mist"
                  >
                    {t("edit")}
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </AdminShell>
  );
}
