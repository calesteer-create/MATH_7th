import crypto from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { verifyPassword } from "./password";

const COOKIE = "m7_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours — an owner session, not a student one.

function secret(): string {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "ADMIN_SESSION_SECRET must be set to at least 32 characters. Generate one with: " +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return value;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(username: string, now = Date.now()): string {
  const exp = now + SESSION_TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string, now = Date.now()): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: string;
      exp?: number;
    };
    if (!data.u || typeof data.exp !== "number" || data.exp < now) return null;
    return data.u;
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function requireAdmin(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new Error("unauthorized");
  return user;
}

export async function authenticate(username: string, password: string): Promise<boolean> {
  const row = getDb()
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.username, username.trim()))
    .get();
  if (!row) {
    // Burn comparable time so a missing user is not distinguishable by timing.
    verifyPassword(password, "scrypt$16384$8$1$00000000000000000000000000000000$00");
    return false;
  }
  return verifyPassword(password, row.passwordHash);
}

export const sessionCookie = {
  name: COOKIE,
  maxAge: SESSION_TTL_SECONDS,
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export function hasOwnerAccount(): boolean {
  try {
    const row = getDb().select({ id: schema.adminUsers.id }).from(schema.adminUsers).all();
    return row.length > 0;
  } catch {
    return false;
  }
}
