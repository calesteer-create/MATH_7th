import { NextResponse } from "next/server";
import { authenticate, createSessionToken, sessionCookie } from "@/lib/auth";
import { routing } from "@/i18n/routing";

export const dynamic = "force-dynamic";

/**
 * Owner sign-in. A plain route handler rather than a Server Action so the flow
 * is exercisable end-to-end (and rate-limitable) without a browser.
 */
function buildCookie(name: string, value: string, maxAge: number): string {
  const parts = [`${name}=${value}`, `Path=/`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export async function POST(req: Request) {
  const form = await req.formData();
  const username = (form.get("username") ?? "").toString().trim().slice(0, 80);
  const password = (form.get("password") ?? "").toString();
  const requestedLocale = (form.get("locale") ?? routing.defaultLocale).toString();
  const locale = routing.locales.includes(requestedLocale as never)
    ? requestedLocale
    : routing.defaultLocale;

  // Relative Location: correct behind a reverse proxy, and never leaks the
  // bind address into a browser-visible redirect.
  const loginUrl = `/${locale}/admin/login`;
  if (!username || !password) {
    return new Response(null, { status: 303, headers: { Location: `${loginUrl}?error=1` } });
  }

  const ok = await authenticate(username, password);
  if (!ok) {
    return new Response(null, { status: 303, headers: { Location: `${loginUrl}?error=1` } });
  }

  const res = new Response(null, { status: 303, headers: { Location: `/${locale}/admin` } });
  res.headers.append("Set-Cookie", buildCookie(sessionCookie.name, createSessionToken(username), sessionCookie.maxAge));
  return res;
}
