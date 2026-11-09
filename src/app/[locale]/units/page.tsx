import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteShell } from "@/components/site-shell";
import { UnitCard } from "@/components/unit-card";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import { listUnits } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function UnitsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "units" });
  const units = listUnits();

  return (
    <SiteShell locale={locale}>
      <SectionHeading title={t("title")} subtitle={t("subtitle")} />
      {units.length === 0 ? (
        <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {units.map((unit, i) => (
            <UnitCard key={unit.id} unit={unit} index={i} />
          ))}
        </ul>
      )}
    </SiteShell>
  );
}
