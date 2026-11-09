import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { EmptyState } from "@/components/ui/primitives";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminQuizzes({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!(await getSessionUser())) redirect(`/${locale}/admin/login`);
  const t = await getTranslations({ locale, namespace: "admin.quizzes" });
  return (
    <AdminShell locale={locale} active="quizzes" title={t("title")}>
      <EmptyState title={t("empty")} body={t("empty")} />
    </AdminShell>
  );
}
