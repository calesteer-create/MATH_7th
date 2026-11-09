import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { ImageManager } from "@/components/admin/image-manager";
import { DeleteLessonButton } from "@/components/admin/delete-buttons";
import { PublishControls } from "@/components/admin/publish-controls";
import { Badge, buttonClass, fieldClass, labelClass } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/lib/auth";
import { getLessonWithUnit, listAllLessonImages } from "@/lib/queries";
import { updateLessonAction, setLastLessonAction } from "../../actions";
import { Ar } from "@/components/ui/ar-text";

export const dynamic = "force-dynamic";

export default async function AdminLessonEdit({
  params,
}: {
  params: Promise<{ locale: string; lessonId: string }>;
}) {
  const { locale, lessonId } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);

  const id = Number(lessonId);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const found = getLessonWithUnit(id);
  if (!found) notFound();

  const t = await getTranslations({ locale, namespace: "admin.lessons" });
  const { lesson, unit } = found;
  const images = listAllLessonImages(id);
  const l = locale as "ar" | "en";

  return (
    <AdminShell
      locale={locale}
      active="lessons"
      title={t("edit")}
      actions={
        <>
          <Badge tone={lesson.status === "published" ? "success" : "neutral"}>
            {lesson.status === "published" ? t("statusPublished") : t("statusDraft")}
          </Badge>
          {lesson.status === "published" ? (
            <Link href={`/lessons/${lesson.id}`} className={buttonClass("secondary", "sm")}>
              {t("openViewer")}
            </Link>
          ) : null}
        </>
      }
    >
      <p className="mb-6 text-sm text-muted">
        <Ar>{unit.titleAr}</Ar>
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card-surface rounded-[var(--radius-card)] p-6">
          <h2 className="mb-5 text-lg font-bold text-mist">{t("edit")}</h2>
          <form action={updateLessonAction.bind(null, id)} className="space-y-4">
            <div>
              <label className={labelClass} htmlFor="titleAr">
                {t("titleAr")} <span className="text-rose-400">*</span>
              </label>
              <input id="titleAr" name="titleAr" required maxLength={200} defaultValue={lesson.titleAr} className={fieldClass} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass} htmlFor="titleEn">
                  {t("titleEn")}
                </label>
                <input id="titleEn" name="titleEn" dir="ltr" maxLength={200} defaultValue={lesson.titleEn} className={fieldClass} />
              </div>
              <div>
                <label className={labelClass} htmlFor="pageLabel">
                  {t("pageLabel")}
                </label>
                <input id="pageLabel" name="pageLabel" maxLength={40} defaultValue={lesson.pageLabel} className={`${fieldClass} bidi-isolate`} />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="submit" className={buttonClass("primary", "md")}>
                {t("save")}
              </button>
            </div>
          </form>

          <hr className="my-6 border-line-soft" />

          <form action={setLastLessonAction.bind(null, id, unit.id, lesson.isLastInUnit !== 1)} className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={lesson.isLastInUnit === 1}
                readOnly
                className="mt-1 size-4 accent-[var(--color-brand-500)]"
              />
              <span>
                <span className="block text-sm font-medium text-mist">{t("isLast")}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-faint">{t("isLastHint")}</span>
              </span>
            </label>
            <button type="submit" className={buttonClass("secondary", "sm")}>
              {t("save")}
            </button>
          </form>
        </section>

        <section className="card-surface rounded-[var(--radius-card)] p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-mist">{t("images")}</h2>
            <span className="bidi-isolate text-xs text-faint">{images.length}</span>
          </div>
          <ImageManager
            lessonId={id}
            locale={l}
            images={images.map((img) => ({
              id: img.id,
              thumbSrc: `/media/i/${img.id}/thumb`,
              previewSrc: `/media/i/${img.id}/web`,
            }))}
            labels={{
              upload: t("upload"),
              uploadHint: t("uploadHint"),
              uploading: t("uploading"),
              ready: t("ready"),
              failed: t("failed"),
              retry: t("retry"),
              preview: t("preview"),
              remove: t("remove"),
              moveUp: t("moveUp"),
              moveDown: t("moveDown"),
              noImages: t("noImages"),
            }}
          />
        </section>
      </div>

      <section className="mt-6 flex flex-wrap items-center gap-3">
        <PublishControls
          lessonId={id}
          published={lesson.status === "published"}
          hasImages={images.length > 0}
          labels={{
            publish: t("publish"),
            unpublish: t("unpublish"),
            blocked: t("publishBlockedNoImages"),
          }}
        />
        <DeleteLessonButton lessonId={id} label={t("delete")} confirm={t("deleteConfirm")} />
      </section>
    </AdminShell>
  );
}
