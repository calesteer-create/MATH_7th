import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { Badge, EmptyState, buttonClass, fieldClass, labelClass } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/lib/auth";
import { listLessons, listUnits } from "@/lib/queries";
import { createLessonAction } from "../actions";
import { Ar } from "@/components/ui/ar-text";

export const dynamic = "force-dynamic";

export default async function AdminLessons({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);

  const t = await getTranslations({ locale, namespace: "admin.lessons" });
  const units = listUnits();

  return (
    <AdminShell locale={locale} active="lessons" title={t("title")}>
      <section className="card-surface mb-8 rounded-[var(--radius-card)] p-6">
        <h2 className="mb-5 text-lg font-bold text-mist">{t("new")}</h2>
        <form action={createLessonAction} className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="unitId">
              {t("unit")} <span className="text-rose-400">*</span>
            </label>
            <select id="unitId" name="unitId" required className={fieldClass} defaultValue="">
              <option value="" disabled>
                {t("selectUnit")}
              </option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.titleAr}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="titleAr">
                {t("titleAr")} <span className="text-rose-400">*</span>
              </label>
              <input id="titleAr" name="titleAr" required maxLength={200} className={fieldClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="pageLabel">
                {t("pageLabel")}
              </label>
              <input id="pageLabel" name="pageLabel" maxLength={40} className={`${fieldClass} bidi-isolate`} />
            </div>
          </div>

          <div className="flex justify-end">
            <button type="submit" className={buttonClass("primary", "md")}>
              {t("create")}
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-8">
        {units.length === 0 ? (
          <EmptyState title={t("empty")} body={t("selectUnit")} />
        ) : (
          units.map((unit) => {
            const lessons = listLessons(unit.id, false);
            return (
              <div key={unit.id}>
                <h2 className="mb-3 text-base font-bold text-mist"><Ar>{unit.titleAr}</Ar></h2>
                {lessons.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line p-4 text-sm text-faint">{t("empty")}</p>
                ) : (
                  <ul className="grid gap-2">
                    {lessons.map((lesson) => (
                      <li key={lesson.id}>
                        <Link
                          href={`/admin/lessons/${lesson.id}`}
                          className="card-surface flex items-center gap-3 rounded-xl p-3.5 transition-colors hover:border-white/20"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-mist"><Ar>{lesson.titleAr}</Ar></span>
                            {lesson.pageLabel ? (
                              <span className="bidi-isolate block text-xs text-faint">{lesson.pageLabel}</span>
                            ) : null}
                          </span>
                          {lesson.isLastInUnit === 1 ? <Badge tone="success">{t("isLast")}</Badge> : null}
                          <Badge tone={lesson.status === "published" ? "brand" : "neutral"}>
                            {lesson.status === "published" ? t("statusPublished") : t("statusDraft")}
                          </Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </section>
    </AdminShell>
  );
}
