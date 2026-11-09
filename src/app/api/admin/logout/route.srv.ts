import { sessionCookie } from "@/lib/auth";
import { routing } from "@/i18n/routing";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const requestedLocale = (form?.get("locale") ?? routing.defaultLocale)?.toString() ?? routing.defaultLocale;
  const locale = routing.locales.includes(requestedLocale as never) ? requestedLocale : routing.defaultLocale;

  const res = new Response(null, {
    status: 303,
    headers: { Location: `/${locale}/admin/login` },
  });
  res.headers.append("Set-Cookie", `${sessionCookie.name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return res;
}
