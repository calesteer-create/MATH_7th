import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("owner password hashing", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const hash = hashPassword("correct horse battery");
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different salt each time", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
    expect(verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
  });
});
