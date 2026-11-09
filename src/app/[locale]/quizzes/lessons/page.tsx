import { getTranslations, setRequestLocale } from "next-intl/server";
import { SiteShell } from "@/components/site-shell";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import { renderPerRequest } from "@/lib/render-mode";

export default async function LessonQuizzesPage({ params }: { params: Promise<{ locale: string }> }) {
  // Server builds: rendered per request like the rest of the public pages
  // (see src/lib/render-mode.ts).
  renderPerRequest();
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
