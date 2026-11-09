import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatCount } from "@/lib/format";
import type { UnitWithCount } from "@/lib/queries";
import { accentVar } from "@/lib/utils";
import { Ar } from "@/components/ui/ar-text";

export function UnitCard({ unit, index }: { unit: UnitWithCount; index: number }) {
  const t = useTranslations("units");
  const locale = useLocale() as "ar" | "en";
  const accent = accentVar(unit.accent);
  const number = formatCount(index + 1, locale);

  return (
    <li className="group animate-rise" style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
      <Link
        href={`/units/${unit.id}`}
        className="card-surface relative block h-full overflow-hidden rounded-[var(--radius-card)] p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
        style={{ ["--accent" as string]: `var(--color-unit-${accent})` }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-70"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -top-16 -end-10 size-40 rounded-full bg-[var(--accent)] opacity-10 blur-3xl transition-opacity duration-500 group-hover:opacity-25"
        />

        <div className="relative flex items-start justify-between gap-4">
          <span
            aria-hidden
            className="grid size-12 shrink-0 place-items-center rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent)]/10 text-lg font-black text-[var(--accent)]"
          >
            {number}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-muted">
            {t("lessonsCount", { count: unit.lessonCount })}
          </span>
        </div>

        <h2 className="relative mt-5 text-xl leading-snug font-bold text-mist transition-colors group-hover:text-white">
          <Ar>{unit.titleAr}</Ar>
        </h2>

        {unit.descriptionAr ? (
          <p className="relative mt-2 line-clamp-2 text-sm leading-relaxed text-muted">
            <Ar>{unit.descriptionAr}</Ar>
          </p>
        ) : null}

        <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-line-soft pt-4">
          {unit.pageFrom || unit.pageTo ? (
            <span className="bidi-isolate text-xs text-faint">
              {t("pageRange", { from: unit.pageFrom || "—", to: unit.pageTo || "—" })}
            </span>
          ) : (
            <span aria-hidden />
          )}
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent)]">
            {t("openUnit")}
            <svg viewBox="0 0 20 20" className="size-4 rtl:rotate-180" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M7 4l6 6-6 6" />
            </svg>
          </span>
        </div>
      </Link>
    </li>
  );
}
