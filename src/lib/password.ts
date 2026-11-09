import crypto from "node:crypto";

/**
 * Password hashing with Node's built-in scrypt.
 *
 * Deliberately no external hashing dependency: scrypt is memory-hard, ships with
 * Node, and keeps the install surface small for a single-owner deployment.
 * Format: scrypt$N$r$p$<salt hex>$<hash hex>
 */
const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(hashHex!, "hex");
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  // Constant-time comparison, so timing does not leak the hash.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
