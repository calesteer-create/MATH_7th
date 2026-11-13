import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { SiteShell } from "@/components/site-shell";
import { PageViewer, type ViewerPage } from "@/components/lesson/page-viewer";
import { Badge, EmptyState, buttonClass } from "@/components/ui/primitives";
import { dirFor } from "@/i18n/routing";
import { getLessonWithUnit, listLessonImages, listPublishedLessonIds } from "@/content/source";
import { accentVar } from "@/lib/utils";
import { Ar } from "@/components/ui/ar-text";
import { renderPerRequest } from "@/lib/render-mode";
import { scanUrl } from "@/lib/scan-url";

/**
 * Static export: one page per published lesson. Drafts are excluded — they
 * are invisible to students, and the page below answers `notFound()` for
 * them, exactly as it does on the server.
 */
export function generateStaticParams() {
  let ids: number[];
  try {
    ids = listPublishedLessonIds();
  } catch {
    // Fresh checkout without a migrated database: nothing to pre-render;
    // the server build renders on demand once the database exists.
    ids = [];
  }
  if (ids.length > 0) return ids.map((id) => ({ lessonId: String(id) }));
  // Never return an empty list: `output: export` refuses it outright, and in
  // server builds an empty list classifies the route as SSG with no paths,
  // which makes on-demand renders fail with DYNAMIC_SERVER_USAGE (HTTP 500)
  // instead of rendering dynamically. One placeholder id keeps the route
  // on-demand (the page answers notFound() for it): no real lesson page
  // exists until content does, on either host. Drafts stay excluded above.
  return [{ lessonId: "0" }];
}

export default async function LessonPage({
  params,
}: {
  params: Promise<{ locale: string; lessonId: string }>;
}) {
  // Server builds: fresh DB reads per request (see src/lib/render-mode.ts).
  renderPerRequest();
  const { locale, lessonId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "lesson" });
  const tu = await getTranslations({ locale, namespace: "unit" });

  const id = Number(lessonId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const found = getLessonWithUnit(id);
  // Drafts are invisible to students, who are never signed in.
  if (!found || found.lesson.status !== "published") notFound();

  const { lesson, unit, siblings } = found;
  const images = listLessonImages(id);
  const accent = accentVar(unit.accent);
  const dir = dirFor(locale);

  // Raw <img> URLs bypass the router, so the prefix is added explicitly by
  // scanUrl(): server build → /media/i/<id>/<variant> (authorised route),
  // static export → /MATH_7th/media/lessons/<lessonId>/<file> (plain file,
  // because GitHub Pages has no server route). See src/lib/scan-url.ts.
  const pages: ViewerPage[] = images.map((img) => ({
    id: img.id,
    thumbSrc: scanUrl({ legacyImageId: img.id, file: img.file, lessonId: lesson.id, variant: "thumb" }),
    src: scanUrl({ legacyImageId: img.id, file: img.file, lessonId: lesson.id, variant: "web" }),
    width: img.width ?? 1600,
    height: img.height ?? 2200,
  }));

  const position = siblings.findIndex((s) => s.id === lesson.id);
  const prev = position > 0 ? siblings[position - 1] : undefined;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : undefined;

  return (
    <SiteShell locale={locale}>
      <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <Link href="/units" className="hover:text-mist">
          {tu("back")}
        </Link>
        <span aria-hidden className="text-faint">
          /
        </span>
        <Link href={`/units/${unit.id}`} className="hover:text-mist">
          <Ar>{unit.titleAr}</Ar>
        </Link>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span className="text-mist">{lesson.titleAr}</span>
      </div>

      <header
        className="mb-8 border-s-2 ps-5"
        style={{ borderInlineStartColor: `var(--color-unit-${accent})` }}
      >
        <h1 className="text-balance text-3xl font-black text-white sm:text-4xl">
          <Ar>{lesson.titleAr}</Ar>
        </h1>
        {lesson.pageLabel ? (
          <p className="bidi-isolate mt-2 text-sm text-faint">
            {tu("lessonPages", { pages: lesson.pageLabel })}
          </p>
        ) : null}
      </header>

      {pages.length === 0 ? (
        <EmptyState title={t("noImagesTitle")} body={t("noImagesBody")} />
      ) : (
        <PageViewer pages={pages} dir={dir} />
      )}

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <div className="card-surface rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white">{t("quizTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("quizNotReady")}</p>
          <div className="mt-4">
            <Badge tone="neutral">{t("quizNotReady")}</Badge>
          </div>
        </div>

        <nav aria-label={t("pages")} className="card-surface flex items-center justify-between gap-3 rounded-2xl p-6">
          {prev ? (
            <Link href={`/lessons/${prev.id}`} className="group min-w-0 text-start">
              <span className="block text-xs text-faint">{t("prevLesson")}</span>
              <span className="block truncate text-sm font-semibold text-mist group-hover:text-brand-300">
                <Ar>{prev.titleAr}</Ar>
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/lessons/${next.id}`} className="group min-w-0 text-end">
              <span className="block text-xs text-faint">{t("nextLesson")}</span>
              <span className="block truncate text-sm font-semibold text-mist group-hover:text-brand-300">
                <Ar>{next.titleAr}</Ar>
              </span>
            </Link>
          ) : null}
        </nav>
      </section>

      <div className="mt-8">
        <Link href={`/units/${unit.id}`} className={buttonClass("secondary", "md")}>
          {t("backToUnit")}
        </Link>
      </div>
    </SiteShell>
  );
}
