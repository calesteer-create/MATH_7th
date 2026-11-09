import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteShell } from "@/components/site-shell";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function LessonQuizzesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "quizzes" });
  return (
    <SiteShell locale={locale}>
      <SectionHeading title={t("lessonsTab")} subtitle={t("lessonsSubtitle")} />
      <EmptyState title={t("emptyLessons")} body={t("lessonsSubtitle")} />
    </SiteShell>
  );
}
