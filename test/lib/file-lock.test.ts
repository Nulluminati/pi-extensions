import { mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../../lib/file-lock.ts";

// Reclaim-race interposition, armed only by the racing-reclaimers test.
// It forces the interleaving the recheck-then-unlink race needs: both
// waiters complete their stale+dead-owner reads before either acts, and
// the second waiter's pathname unlink lands only after the first has
// created a fresh lock and entered its critical section. Every other
// test runs the real fs untouched.
const reclaimRace = vi.hoisted(() => ({
  armed: false,
  readCounts: new Map<string, number>(),
  unlinkCounts: new Map<string, number>(),
  readBarriers: new Map<string, { gate: Promise<void>; release: () => void }>(),
  sectionStarted: undefined as Promise<void> | undefined,
  sectionStartedRelease: undefined as (() => void) | undefined,
  arm() {
    this.armed = true;
    if (this.sectionStarted === undefined) {
      this.sectionStarted = new Promise<void>((resolve) => {
        this.sectionStartedRelease = resolve;
      });
    }
  },
  disarm() {
    this.armed = false;
    this.readCounts.clear();
    this.unlinkCounts.clear();
    this.readBarriers.clear();
    this.sectionStarted = undefined;
    this.sectionStartedRelease = undefined;
  },
  barrierFor(path: string) {
    let entry = this.readBarriers.get(path);
    if (!entry) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry = { gate, release };
      this.readBarriers.set(path, entry);
    }
    return entry;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const passthrough =
    <T>(fn: (...args: never[]) => Promise<T>) =>
    (path: never, ...rest: never[]) =>
      (fn as (p: never, ...r: never[]) => Promise<T>)(path, ...rest);
  return {
    ...actual,
    readFile: vi.fn(async (path: unknown, ...rest: unknown[]) => {
      if (
        reclaimRace.armed &&
        typeof path === "string" &&
        path.endsWith(".lock") &&
        rest[0] === "utf8"
      ) {
        const barrier = reclaimRace.barrierFor(path);
        const count = (reclaimRace.readCounts.get(path) ?? 0) + 1;
        reclaimRace.readCounts.set(path, count);
        // Both waiters must observe the same stale content before either
        // acts: hold the first owner-read until the second arrives.
        if (count === 1) await barrier.gate;
        else barrier.release();
      }
      return passthrough(actual.readFile)(path as never, ...(rest as never[]));
    }),
    unlink: vi.fn(async (path: unknown, ...rest: unknown[]) => {
      if (reclaimRace.armed && typeof path === "string" && path.endsWith(".lock")) {
        const count = (reclaimRace.unlinkCounts.get(path) ?? 0) + 1;
        reclaimRace.unlinkCounts.set(path, count);
        // Simulate the second waiter's unlink having been delayed past the
        // first waiter's create: it must not destroy a fresh replacement.
        if (count >= 2) await reclaimRace.sectionStarted;
      }
      return passthrough(actual.unlink)(path as never, ...(rest as never[]));
    }),
  };
});

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
      // First observation happens while the lock is held: the `<pid> <token>
      // [startedAt]` record must already be there — the lock is never
      // observable empty, and no staging temp sibling survives acquisition.
      const content = await readFile(lockPath, "utf8");
      expect(content).toMatch(new RegExp(`^${process.pid} [0-9a-f]+(?: [^\n]+)?\\n$`));
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

  it("two waiters racing to reclaim the same stale lock cannot both hold it", async () => {
    const lockPath = join(dir, "test.lock");
    await writeFile(lockPath, "999999\n");
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    reclaimRace.arm();
    let inside = 0;
    let overlapping = 0;
    const work = async (label: string): Promise<string> => {
      inside += 1;
      if (inside > 1) overlapping += 1;
      reclaimRace.sectionStartedRelease?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      inside -= 1;
      return label;
    };

    try {
      const [first, second] = await Promise.all([
        withFileLock(lockPath, () => work("first"), { staleMs: 1_000 }),
        withFileLock(lockPath, () => work("second"), { staleMs: 1_000 }),
      ]);
      expect([first, second].sort()).toEqual(["first", "second"]);
      // The forced interleaving: both waiters observe the same stale owner,
      // and the second waiter's unlink lands after the first has created a
      // fresh lock and started working. The critical sections must still
      // have been exclusive.
      expect(overlapping).toBe(0);
    } finally {
      reclaimRace.disarm();
    }
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an ownerless corrupt lock file", async () => {
    const lockPath = join(dir, "test.lock");
    await writeFile(lockPath, "not-a-pid\n");
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

  it("reclaims a stale lock whose live pid carries a mismatched start stamp", async () => {
    const lockPath = join(dir, "test.lock");
    // The pid is live, but the recorded start time differs: the original
    // holder died and the pid was recycled. The lock is genuinely orphaned.
    await writeFile(lockPath, `${process.pid} some-token Mon Jan 2 03:04:05 2001\n`);
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    await expect(withFileLock(lockPath, async () => "reclaimed", { staleMs: 1_000 })).resolves.toBe(
      "reclaimed",
    );
  });

  it("does not reclaim a stale lock whose stamped start time matches the live holder", async () => {
    const lockPath = join(dir, "test.lock");
    const { processStartTime } = await import("../../lib/process-identity.ts");
    const stamp = await processStartTime(process.pid);
    await writeFile(lockPath, `${process.pid} some-token ${stamp}\n`);
    const abandoned = new Date(Date.now() - 120_000);
    await utimes(lockPath, abandoned, abandoned);

    await expect(
      withFileLock(lockPath, async () => "stolen", { staleMs: 1_000, timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out waiting for lock/);
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
