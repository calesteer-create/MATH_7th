/**
 * Contract tests for the build-mode markers the export design relies on:
 *
 *   - BASE_PATH is "" on the server and "/MATH_7th" in the export build;
 *   - renderPerRequest() forces dynamic rendering on the server and stays a
 *     no-op during the export (so pages can be prerendered).
 *
 * The markers are read from the environment, so each case re-imports the
 * module with a clean module registry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("next/cache");
});

describe("base path markers", () => {
  it("is empty on the server build", async () => {
    const { BASE_PATH, isStaticExport } = await import("@/lib/base-path");
    expect(isStaticExport()).toBe(false);
    expect(BASE_PATH).toBe("");
  });

  it("is /MATH_7th when NEXT_OUTPUT=export", async () => {
    vi.stubEnv("NEXT_OUTPUT", "export");
    const { BASE_PATH, isStaticExport } = await import("@/lib/base-path");
    expect(isStaticExport()).toBe(true);
    expect(BASE_PATH).toBe("/MATH_7th");
  });

  it("is /MATH_7th when the inlined NEXT_STATIC_EXPORT marker is set", async () => {
    vi.stubEnv("NEXT_STATIC_EXPORT", "1");
    const { BASE_PATH, isStaticExport } = await import("@/lib/base-path");
    expect(isStaticExport()).toBe(true);
    expect(BASE_PATH).toBe("/MATH_7th");
  });
});

describe("renderPerRequest", () => {
  it("marks the render dynamic on the server", async () => {
    const noStore = vi.fn();
    vi.doMock("next/cache", () => ({ unstable_noStore: noStore }));
    const { renderPerRequest } = await import("@/lib/render-mode");
    renderPerRequest();
    expect(noStore).toHaveBeenCalledTimes(1);
  });

  it("prerenders statically during the export", async () => {
    const noStore = vi.fn();
    vi.doMock("next/cache", () => ({ unstable_noStore: noStore }));
    vi.stubEnv("NEXT_OUTPUT", "export");
    const { renderPerRequest } = await import("@/lib/render-mode");
    renderPerRequest();
    expect(noStore).not.toHaveBeenCalled();
  });
});
