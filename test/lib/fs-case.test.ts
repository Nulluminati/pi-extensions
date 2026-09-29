import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { isCaseInsensitiveVolume } from "../../lib/fs-case.ts";

// statSync is wrapped (not replaced) so the probe interception can pick
// which directories report a case-flipped twin, like the messenger tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const dirs: string[] = [];

beforeEach(() => {
  vi.mocked(statSync).mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function interceptVolumeCase(foldingDirs: string[]): void {
  const mocked = statSync as unknown as Mock<(...args: unknown[]) => unknown>;
  const callThrough = mocked.getMockImplementation();
  if (!callThrough) throw new Error("real statSync implementation missing");
  mocked.mockImplementation((path: unknown, options?: unknown) => {
    const probed = String(path);
    if (probed.toLowerCase().includes("case-probe-")) {
      if (foldingDirs.some((dir) => probed.startsWith(dir))) {
        throw Object.assign(new Error(`ENOENT: ${probed}`), { code: "ENOENT" });
      }
      return {}; // The case-flipped twin exists: the volume folds case.
    }
    return callThrough(path, options);
  });
}

describe("isCaseInsensitiveVolume", () => {
  it("reports a volume that resolves a case-flipped twin as folding", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-case-folding-"));
    dirs.push(dir);
    interceptVolumeCase([]);
    expect(isCaseInsensitiveVolume(dir)).toBe(true);
  });

  it("reports a volume missing the case-flipped twin as case-sensitive", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-case-exact-"));
    dirs.push(dir);
    interceptVolumeCase([dir]);
    expect(isCaseInsensitiveVolume(dir)).toBe(false);
  });

  it("caches the verdict per directory within the TTL window", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-case-cache-"));
    dirs.push(dir);
    interceptVolumeCase([dir]);
    expect(isCaseInsensitiveVolume(dir)).toBe(false);
    const probesAfterFirst = vi
      .mocked(statSync)
      .mock.calls.filter((call) => String(call[0]).includes("case-probe-")).length;
    expect(isCaseInsensitiveVolume(dir)).toBe(false);
    const probesAfterSecond = vi
      .mocked(statSync)
      .mock.calls.filter((call) => String(call[0]).includes("case-probe-")).length;
    expect(probesAfterSecond).toBe(probesAfterFirst);
  });

  it("fails safe by reporting folding when the probe cannot run", () => {
    const dir = join(tmpdir(), `fs-case-probe-fail-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    vi.mocked(statSync).mockImplementation((() => {
      throw new Error("EACCES: probe blocked");
    }) as never);
    expect(isCaseInsensitiveVolume(dir)).toBe(true);
  });
});
