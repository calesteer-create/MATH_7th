import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { UnitForm } from "@/components/admin/unit-form";
import { DeleteUnitButton } from "@/components/admin/delete-buttons";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/lib/auth";
import { getUnit, listLessons } from "@/lib/queries";
import { updateUnitAction } from "../../actions";
import { Ar } from "@/components/ui/ar-text";

export const dynamic = "force-dynamic";

export default async function AdminUnitEdit({
  params,
}: {
  params: Promise<{ locale: string; unitId: string }>;
}) {
  const { locale, unitId } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);

  const id = Number(unitId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const unit = getUnit(id);
  if (!unit) notFound();

  const t = await getTranslations({ locale, namespace: "admin.units" });
  const tl = await getTranslations({ locale, namespace: "admin.lessons" });
  const lessons = listLessons(id, false);

  return (
    <AdminShell locale={locale} active="units" title={t("edit")}>
      <section className="card-surface mb-8 rounded-[var(--radius-card)] p-6">
        <UnitForm locale={locale} unit={unit} action={updateUnitAction.bind(null, id)} submitLabel={t("save")} />
      </section>

      <section className="card-surface mb-8 rounded-[var(--radius-card)] p-6">
        <h2 className="mb-4 text-lg font-bold text-mist">{tl("title")}</h2>
        {lessons.length === 0 ? (
          <p className="text-sm text-muted">{tl("empty")}</p>
        ) : (
          <ul className="grid gap-2">
            {lessons.map((lesson, i) => (
              <li key={lesson.id} className="flex items-center gap-3 rounded-xl border border-line-soft p-3">
                <span className="bidi-isolate w-6 text-center text-xs text-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-mist"><Ar>{lesson.titleAr}</Ar></span>
                <Badge tone={lesson.status === "published" ? "success" : "neutral"}>
                  {lesson.status === "published" ? tl("statusPublished") : tl("statusDraft")}
                </Badge>
                <Link href={`/admin/lessons/${lesson.id}`} className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-muted hover:text-mist">
                  {tl("edit")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DeleteUnitButton unitId={id} label={t("delete")} confirm={t("deleteConfirm")} />
    </AdminShell>
  );
}
