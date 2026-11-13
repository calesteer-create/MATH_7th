import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { SiteShell } from "@/components/site-shell";
import { UnitCard } from "@/components/unit-card";
import { EmptyState, buttonClass } from "@/components/ui/primitives";
import { formatCount } from "@/lib/format";
import { listUnits, overviewStats } from "@/lib/queries";
import { renderPerRequest } from "@/lib/render-mode";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  // Server builds: fresh DB reads per request (see src/lib/render-mode.ts).
  renderPerRequest();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "home" });
  const tu = await getTranslations({ locale, namespace: "units" });
  const l = locale as "ar" | "en";

  const units = listUnits();
  const stats = overviewStats();

  const counters = [
    { label: t("unitsCount"), value: stats.units },
    { label: t("lessonsCount"), value: stats.published },
    { label: t("quizzesCount"), value: 0 },
  ];

  const steps = [
    { title: t("step1Title"), body: t("step1Body"), n: 1 },
    { title: t("step2Title"), body: t("step2Body"), n: 2 },
    { title: t("step3Title"), body: t("step3Body"), n: 3 },
  ];

  return (
    <SiteShell locale={locale}>
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-[2rem] border border-line bg-ink-900/70 px-6 py-16 sm:px-12 sm:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 start-1/4 size-96 rounded-full bg-brand-500/25 blur-[110px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 end-0 size-96 rounded-full bg-indigo-400/20 blur-[110px]"
        />

        <div className="relative max-w-2xl">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand-400/40 bg-brand-500/12 px-3.5 py-1.5 text-xs font-medium text-brand-300">
            <span aria-hidden className="size-1.5 rounded-full bg-brand-300" />
            {t("eyebrow")}
          </p>
          <h1 className="text-balance text-4xl leading-[1.15] font-black text-white sm:text-6xl">
            {t("title")}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            {t("subtitle")}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/units" className={buttonClass("primary", "lg")}>
              {t("startCta")}
            </Link>
          </div>
        </div>

        <dl className="relative mt-14 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-line bg-line">
          {counters.map((c) => (
            <div key={c.label} className="bg-ink-900 px-4 py-5 text-center">
              <dt className="order-2 mt-1 text-xs text-faint">{c.label}</dt>
              <dd className="bidi-isolate text-3xl font-black text-mist">
                {formatCount(c.value, l)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section className="mt-20">
        <h2 className="text-2xl font-bold text-white sm:text-3xl">{t("howTitle")}</h2>
        <ol className="mt-8 grid gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <li
              key={s.n}
              className="card-surface animate-rise rounded-2xl p-6"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <span
                aria-hidden
                className="bidi-isolate mb-4 inline-grid size-9 place-items-center rounded-xl border border-brand-400/30 bg-brand-500/16 text-sm font-bold text-brand-300"
              >
                {formatCount(s.n, l)}
              </span>
              <h3 className="text-lg font-semibold text-white">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Units ────────────────────────────────────────────── */}
      <section className="mt-20">
        <div className="mb-8 flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold text-white sm:text-3xl">{t("browseUnits")}</h2>
          <Link href="/units" className="text-sm font-medium text-brand-300 hover:text-brand-400">
            {t("browseUnits")} →
          </Link>
        </div>

        {units.length === 0 ? (
          <EmptyState
            title={tu("emptyTitle")}
            body={tu("emptyBody")}
            action={
              <Link href="/units" className={buttonClass("secondary", "md")}>
                {tu("title")}
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {units.map((unit, i) => (
              <UnitCard key={unit.id} unit={unit} index={i} />
            ))}
          </ul>
        )}
      </section>
    </SiteShell>
  );
}
