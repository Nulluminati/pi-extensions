import { mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
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

  it("carries the ownership record at first observation of the lock file", async () => {
    const lockPath = join(dir, "test.lock");

    await withFileLock(lockPath, async () => {
      // First observation happens while the lock is held: the `<pid> <token>`
      // record must already be there — the lock is never observable empty,
      // and no staging temp sibling survives acquisition.
      const content = await readFile(lockPath, "utf8");
      expect(content).toMatch(new RegExp(`^${process.pid} [0-9a-f]+\\n$`));
      await expect(readdir(dir)).resolves.toEqual(["test.lock"]);
    });
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
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const holder = withFileLock(lockPath, async () => {
      events.push("holder-start");
      await gate;
    });
    // withFileLock acquires asynchronously — wait until the holder actually
    // holds before starting the waiter, or the two acquisitions race.
    await vi.waitFor(() => expect(events).toContain("holder-start"));
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

  it("does not delete another holder's replacement lock on release", async () => {
    const lockPath = join(dir, "test.lock");
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const holder = withFileLock(lockPath, async () => {
      await gate;
    });
    await vi.waitFor(() => expect(stat(lockPath)).resolves.toBeTruthy());

    // Simulate a waiter having reclaimed the (stale) lock and created its own
    // replacement at the same pathname. The original holder must leave that
    // file alone when it releases: deleting by pathname would open the
    // critical section to a third process while the replacement holder is
    // still active.
    await unlink(lockPath);
    await writeFile(lockPath, "someone-else\n");

    releaseFirst();
    await holder;

    await expect(stat(lockPath)).resolves.toBeTruthy();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("someone-else\n");
    await unlink(lockPath);
  });

  it("does not refresh a lock it no longer owns", async () => {
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
      { staleMs: 60_000, refreshMs: 30 },
    );
    await vi.waitFor(() => expect(stat(lockPath)).resolves.toBeTruthy());

    // Replace the lock file at the pathname. The holder's refresh interval
    // must touch only the inode it created, never the pathname: refreshing
    // the replacement would keep a foreign lock alive past its stale window.
    await unlink(lockPath);
    await writeFile(lockPath, "someone-else\n");
    const foreignMtime = (await stat(lockPath)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect((await stat(lockPath)).mtimeMs).toBe(foreignMtime);
    releaseFirst();
    await holder;
    await unlink(lockPath);
  });

  it("does not reclaim a stale lock while the recorded holder pid is alive", async () => {
    const lockPath = join(dir, "test.lock");
    // Stale mtime, but the recorded pid belongs to this live test process:
    // staleness alone must not grant the lock to a waiter.
    await writeFile(lockPath, `${process.pid} some-token\n`);
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    await expect(
      withFileLock(lockPath, async () => "stolen", { staleMs: 1_000, timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out waiting for lock/);
    await expect(stat(lockPath)).resolves.toBeTruthy();
  });

  it("does not steal a live hold that keeps refreshing its mtime", async () => {
    const lockPath = join(dir, "test.lock");
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // staleMs is far beyond the test horizon, so the staleness path can never
    // fire: the waiter must lose to its own timeout, not to a steal. The
    // refresh mechanism is asserted separately via the advancing mtime.
    const holder = withFileLock(
      lockPath,
      async () => {
        await gate;
      },
      { staleMs: 60_000, refreshMs: 50 },
    );
    // withFileLock acquires asynchronously — wait until the holder actually
    // holds before reading the mtime or starting the waiter.
    await vi.waitFor(async () => {
      await expect(stat(lockPath)).resolves.toBeTruthy();
    });
    const initialMtime = (await stat(lockPath)).mtimeMs;
    const waiter = withFileLock(lockPath, async () => "stolen", {
      staleMs: 60_000,
      refreshMs: 50,
      timeoutMs: 150,
    });
    // Attach the rejection expectation before the waiter's deadline passes.
    const waiterTimedOut = expect(waiter).rejects.toThrow(/Timed out waiting/);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await waiterTimedOut;
    // The holder's refresh interval has touched the lock since acquisition.
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(initialMtime);
    await expect(stat(lockPath)).resolves.toBeTruthy();
    releaseFirst();
    await holder;
  });
});
