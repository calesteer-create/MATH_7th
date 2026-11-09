import { setRequestLocale } from "next-intl/server";
import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Single-owner admin. Everything below /admin except /admin/login requires the
 * signed session cookie. Students never sign in and never reach this tree.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <div lang={locale}>{children}</div>;
}

export async function requireOwner() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  return user;
}
