import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth";

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = "test-secret-".padEnd(48, "x");
});

describe("admin session cookie", () => {
  it("round-trips a username", () => {
    const token = createSessionToken("owner");
    expect(verifySessionToken(token)).toBe("owner");
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken("owner");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "attacker", exp: Date.now() + 1e9 })).toString(
      "base64url",
    );
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("rejects an expired token", () => {
    const token = createSessionToken("owner", Date.now() - 60 * 60 * 24 * 1000);
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("abc")).toBeNull();
  });
});
