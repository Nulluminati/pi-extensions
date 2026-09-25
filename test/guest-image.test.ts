import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGuestImagePath } from "../lib/guest-image.ts";

describe("guest-image", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when the cache dir has no guest image", () => {
    vi.stubEnv("XDG_CACHE_HOME", mkdtempSync(join(os.tmpdir(), "guest-image-empty-")));

    expect(resolveGuestImagePath()).toBeUndefined();
  });

  it("returns undefined when the guest dir lacks manifest.json", () => {
    const cacheRoot = mkdtempSync(join(os.tmpdir(), "guest-image-partial-"));
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    mkdirSync(join(cacheRoot, "pi-gondolin", "guest"), { recursive: true });

    expect(resolveGuestImagePath()).toBeUndefined();
  });

  it("returns the guest dir when manifest.json marks a complete image", () => {
    const cacheRoot = mkdtempSync(join(os.tmpdir(), "guest-image-full-"));
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    const guestDir = join(cacheRoot, "pi-gondolin", "guest");
    mkdirSync(guestDir, { recursive: true });
    writeFileSync(join(guestDir, "manifest.json"), "{}");

    expect(resolveGuestImagePath()).toBe(guestDir);
  });
});
