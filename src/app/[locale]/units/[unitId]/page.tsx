import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { SiteShell } from "@/components/site-shell";
import { Badge, EmptyState, buttonClass } from "@/components/ui/primitives";
import { formatCount } from "@/lib/format";
import { getUnit, listLessons, listUnits, unitIsComplete } from "@/lib/queries";
import { accentVar, cx } from "@/lib/utils";
import { Ar } from "@/components/ui/ar-text";
import { renderPerRequest } from "@/lib/render-mode";

/**
 * Static export: one page per unit that exists at build time. On the server
 * the page stays per-request (renderPerRequest below), so unknown ids still
 * render on demand.
 */
export function generateStaticParams() {
  let ids: number[];
  try {
    ids = listUnits().map((unit) => unit.id);
  } catch {
    // Fresh checkout without a migrated database: nothing to pre-render;
    // the server build renders on demand once the database exists.
    ids = [];
  }
  if (ids.length > 0) return ids.map((id) => ({ unitId: String(id) }));
  // Never return an empty list: `output: export` refuses it outright, and in
  // server builds an empty list classifies the route as SSG with no paths,
  // which makes on-demand renders fail with DYNAMIC_SERVER_USAGE (HTTP 500)
  // instead of rendering dynamically. One placeholder id keeps the route
  // on-demand (the page answers notFound() for it): no real unit page exists
  // until content does, on either host.
  return [{ unitId: "0" }];
}

export default async function UnitPage({
  params,
}: {
  params: Promise<{ locale: string; unitId: string }>;
}) {
  // Server builds: fresh DB reads per request (see src/lib/render-mode.ts).
  renderPerRequest();
  const { locale, unitId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "unit" });
  const l = locale as "ar" | "en";

  const id = Number(unitId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const unit = getUnit(id);
  if (!unit) notFound();

  const lessons = listLessons(id, true);
  const complete = unitIsComplete(id);
  const accent = accentVar(unit.accent);

  return (
    <SiteShell locale={locale}>
      <Link href="/units" className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-mist">
        <svg viewBox="0 0 20 20" className="size-4 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M13 4l-6 6 6 6" />
        </svg>
        {t("back")}
      </Link>

      <header
        className="card-surface relative overflow-hidden rounded-[var(--radius-card)] p-7 sm:p-9"
        style={{ ["--accent" as string]: `var(--color-unit-${accent})` }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -top-24 -end-16 size-72 rounded-full bg-[var(--accent)] opacity-12 blur-[90px]"
        />
        <div className="relative">
          <Badge tone="brand" className="mb-4">
            {t("lessonsTitle")}
          </Badge>
          <h1 className="text-balance text-3xl font-black text-white sm:text-4xl">
            <Ar>{unit.titleAr}</Ar>
          </h1>
          {unit.descriptionAr ? (
            <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            <Ar>{unit.descriptionAr}</Ar>
          </p>
          ) : null}
          {unit.pageFrom || unit.pageTo ? (
            <p className="bidi-isolate mt-4 text-sm text-faint">
              {t("lessonPages", { pages: `${unit.pageFrom || "—"} – ${unit.pageTo || "—"}` })}
            </p>
          ) : null}
        </div>
      </header>

      <section className="mt-10">
        <h2 className="mb-5 text-xl font-bold text-mist">{t("lessonsTitle")}</h2>

        {lessons.length === 0 ? (
          <EmptyState title={t("noLessonsTitle")} body={t("noLessonsBody")} />
        ) : (
          <ol className="grid gap-3">
            {lessons.map((lesson, i) => {
              const isLast = lesson.isLastInUnit === 1;
              return (
                <li key={lesson.id} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
                  <Link
                    href={`/lessons/${lesson.id}`}
                    className="card-surface group flex items-center gap-4 rounded-2xl p-4 transition-all hover:-translate-y-0.5 hover:border-white/20 sm:p-5"
                    style={{ ["--accent" as string]: `var(--color-unit-${accent})` }}
                  >
                    <span
                      aria-hidden
                      className="bidi-isolate grid size-11 shrink-0 place-items-center rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/10 text-sm font-bold text-[var(--accent)]"
                    >
                      {formatCount(i + 1, l)}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-semibold text-mist group-hover:text-white">
                        <Ar>{lesson.titleAr}</Ar>
                      </span>
                      {lesson.pageLabel ? (
                        <span className="bidi-isolate mt-0.5 block text-xs text-faint">
                          {t("lessonPages", { pages: lesson.pageLabel })}
                        </span>
                      ) : null}
                    </span>

                    {isLast ? <Badge tone="success">{t("lastLesson")}</Badge> : null}

                    <svg viewBox="0 0 20 20" className="size-5 shrink-0 text-faint transition-transform group-hover:text-[var(--accent)] rtl:-scale-x-100" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <path d="M7 4l6 6-6 6" />
                    </svg>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="mt-10">
        <div
          className={cx(
            "card-surface flex flex-col items-start justify-between gap-4 rounded-2xl p-6 sm:flex-row sm:items-center",
            complete && "border-brand-500/25",
          )}
        >
          <div>
            <h2 className="text-lg font-bold text-mist">{t("quizTitle")}</h2>
            <p className="mt-1 text-sm text-muted">
              {complete ? t("quizSubtitle") : t("quizNotReady")}
            </p>
          </div>
          {complete ? (
            <Link href={`/quizzes/unit/${id}`} className={buttonClass("primary", "md")}>
              {t("takeQuiz")}
            </Link>
          ) : (
            <Badge tone="neutral">{t("quizNotReady")}</Badge>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
