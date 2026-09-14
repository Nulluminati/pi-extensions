import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../../lib/file-lock.ts";

describe("file-lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns fn's value and removes the lock file after release", async () => {
    const lockPath = join(dir, "nested", "test.lock");

    const value = await withFileLock(lockPath, async () => "result");

    expect(value).toBe("result");
    // withFileLock creates the parent directory, and a full release leaves
    // nothing in it.
    await expect(readdir(join(dir, "nested"))).resolves.toEqual([]);
  });

  it("serializes overlapping critical sections", async () => {
    const lockPath = join(dir, "test.lock");
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(lockPath, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    await vi.waitFor(() => expect(events).toContain("first-start"));

    const second = withFileLock(lockPath, async () => {
      events.push("second");
    });
    // The holder still owns the lock, so the waiter cannot start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).not.toContain("second");

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("times out a waiter that cannot acquire within timeoutMs", async () => {
    const lockPath = join(dir, "test.lock");
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const holder = withFileLock(lockPath, async () => {
      await gate;
    });
    const waiter = withFileLock(lockPath, async () => "unreachable", { timeoutMs: 100 });
    // Attach the rejection expectation before the waiter's deadline passes.
    const waiterTimedOut = expect(waiter).rejects.toThrow(/Timed out waiting for lock/);

    await waiterTimedOut;
    releaseFirst();
    await holder;
  });

  it("releases the lock when fn throws", async () => {
    const lockPath = join(dir, "test.lock");

    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    // The lock is free again: a second acquisition succeeds immediately.
    await expect(withFileLock(lockPath, async () => "again")).resolves.toBe("again");
  });

  it("reclaims a stale lock left by a crashed holder", async () => {
    const lockPath = join(dir, "test.lock");
    await writeFile(lockPath, "999999\n");
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    const value = await withFileLock(lockPath, async () => "reclaimed", { staleMs: 1_000 });

    expect(value).toBe("reclaimed");
  });

  it("does not steal a live hold that keeps refreshing its mtime", async () => {
    const lockPath = join(dir, "test.lock");
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const holder = withFileLock(
      lockPath,
      async () => {
        await gate;
      },
      { staleMs: 150, refreshMs: 50 },
    );
    const waiter = withFileLock(lockPath, async () => "stolen", {
      staleMs: 150,
      refreshMs: 50,
      timeoutMs: 400,
    });
    // Attach the rejection expectation before the waiter's deadline passes.
    const waiterTimedOut = expect(waiter).rejects.toThrow(/Timed out waiting/);

    // Well past the stale window: the holder's refresh interval keeps the
    // lock mtime fresh, so the waiter must time out rather than steal it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waiterTimedOut;
    await expect(stat(lockPath)).resolves.toBeTruthy();
    releaseFirst();
    await holder;
  });
});
