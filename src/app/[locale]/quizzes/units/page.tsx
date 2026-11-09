import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteShell } from "@/components/site-shell";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function UnitQuizzesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "quizzes" });
  return (
    <SiteShell locale={locale}>
      <SectionHeading title={t("unitsTab")} subtitle={t("unitsSubtitle")} />
      <EmptyState title={t("emptyUnits")} body={t("unitsSubtitle")} />
    </SiteShell>
  );
}
