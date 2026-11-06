import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  loadShards,
  readShard,
  removeShard,
  shardPath,
  writeShard,
} from "../../lib/presence-shards.ts";

describe("presence-shards", () => {
  let dir: string;

  const record = (name: string, pid = process.pid) => ({ name, pid, lastSeenAt: 1 });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "presence-shards-"));
  });

  afterEach(async () => {
    for (const restore of globalRestores) restore();
    globalRestores.length = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one shard per agent without touching other agents' shards", async () => {
    await writeShard(dir, record("agent-a"));
    const pathA = shardPath(dir, "agent-a");
    const before = existsSync(pathA) ? pathA : "";

    await writeShard(dir, { ...record("agent-b"), lastSeenAt: 2 });

    expect(existsSync(shardPath(dir, "agent-b"))).toBe(true);
    expect(shardPath(dir, "agent-a")).toBe(join(dir, "agent-a.json"));
    expect(before).toBe(join(dir, "agent-a.json"));
  });

  it("encodes agent names into safe filenames", () => {
    expect(shardPath(dir, "a/b")).toBe(join(dir, `${encodeURIComponent("a/b")}.json`));
  });

  it("readShard reads a single shard without side effects", async () => {
    await writeShard(dir, record("agent-a"));

    const shard = await readShard<{ name: string; pid: number; lastSeenAt: number }>(
      dir,
      "agent-a",
    );

    expect(shard?.name).toBe("agent-a");
    expect(await readShard(dir, "missing")).toBeUndefined();
  });

  it("loadShards reads all shards keyed by the stored name", async () => {
    await writeShard(dir, record("agent-a"));
    await writeShard(dir, record("agent-b"));
    const registry = await loadShards(dir);

    expect(registry["agent-a"]).toBeDefined();
    expect(registry["agent-b"]).toBeDefined();
  });

  it("prunes shards whose pid is dead", async () => {
    await writeShard(dir, record("dead-agent", 999999999));
    await writeShard(dir, record("live-agent", process.pid));

    const registry = await loadShards(dir);

    expect(registry["dead-agent"]).toBeUndefined();
    expect(existsSync(shardPath(dir, "dead-agent"))).toBe(false);
    expect(registry["live-agent"]).toBeDefined();
  });

  it("fails closed on a corrupt shard instead of deleting it", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "not json", "utf8");

    // Deletion is how durable presence gets destroyed by a read: a corrupt
    // shard must fail visibly and stay on disk for inspection or repair.
    await expect(loadShards(dir)).rejects.toThrow(/broken\.json/);
    expect(existsSync(join(dir, "broken.json"))).toBe(true);
  });

  it("loadShards rejects when the registry directory exists but is unreadable", async () => {
    // Root ignores file permissions, making the chmod scenario ineffective.
    if (process.getuid?.() === 0) return;
    await chmod(dir, 0o000);
    try {
      // An unreadable registry must not read as an empty one, or a later
      // write can clobber durable presence.
      await expect(loadShards(dir)).rejects.toThrow(/unreadable/);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("a missing registry directory still resolves to an empty registry", async () => {
    await rm(dir, { recursive: true, force: true });

    await expect(loadShards(dir)).resolves.toEqual({});
  });

  it("migrates a legacy single-file registry to shards on read", async () => {
    const legacyPath = join(dir, "..", "legacy-registry.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        "live-agent": record("live-agent"),
        "dead-agent": record("dead-agent", 999999999),
      }),
      "utf8",
    );

    const registry = await loadShards(dir, { legacyPath });

    expect(registry["live-agent"]).toBeDefined();
    expect(registry["dead-agent"]).toBeUndefined();
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(shardPath(dir, "live-agent"))).toBe(true);
    await rm(legacyPath, { force: true });
  });

  it("removeShard deletes only the named agent's shard", async () => {
    await writeShard(dir, record("agent-a"));
    await writeShard(dir, record("agent-b"));

    await removeShard(dir, "agent-a");

    expect(existsSync(shardPath(dir, "agent-a"))).toBe(false);
    expect(existsSync(shardPath(dir, "agent-b"))).toBe(true);
  });

  it("isProcessAlive distinguishes live and dead pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999999999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it("isProcessAlive treats EPERM as a live process", () => {
    // EPERM means the process exists but the caller cannot signal it (other
    // user, sandbox): pruning it would drop a live session's presence.
    failKillFor({ 4242: killError("EPERM") });
    expect(isProcessAlive(4242)).toBe(true);
  });

  it("isProcessAlive keeps other uncertain kill errors dead", () => {
    // Only EPERM proves existence; every other error keeps the historical
    // conservative result instead of guessing.
    failKillFor({ 4242: killError("EACCES") });
    expect(isProcessAlive(4242)).toBe(false);
  });

  it("loadShards keeps a shard whose pid exists but cannot be signalled", async () => {
    failKillFor({ 4242: killError("EPERM") });
    await writeShard(dir, record("sandboxed-agent", 4242));

    const registry = await loadShards(dir);

    expect(registry["sandboxed-agent"]).toMatchObject({ name: "sandboxed-agent", pid: 4242 });
    expect(existsSync(shardPath(dir, "sandboxed-agent"))).toBe(true);
  });

  it("loadShards still prunes a shard whose pid reports ESRCH", async () => {
    failKillFor({ 4242: killError("ESRCH") });
    await writeShard(dir, record("gone-agent", 4242));

    const registry = await loadShards(dir);

    expect(registry["gone-agent"]).toBeUndefined();
    expect(existsSync(shardPath(dir, "gone-agent"))).toBe(false);
  });

  it("writeShard stamps the record with the writer's process start time", async () => {
    await writeShard(dir, record("stamped-agent"));

    const stored = JSON.parse(await readShard(dir, "stamped-agent").then((r) => JSON.stringify(r)));
    expect(typeof stored.processStartedAt).toBe("string");
    expect(stored.processStartedAt.length).toBeGreaterThan(0);
    // An explicitly provided stamp is preserved, not overwritten.
    await writeShard(dir, { ...record("fixed-agent"), processStartedAt: "explicit" });
    expect((await readShard(dir, "fixed-agent"))?.processStartedAt).toBe("explicit");
  });

  it("loadShards prunes a shard whose live pid is a recycled occupant", async () => {
    // The pid answers kill(0) (a live process owns it now), but the start
    // time differs from the stamp: the original owner is long gone.
    await writeShard(dir, {
      ...record("recycled-agent", process.pid),
      processStartedAt: "Mon Jan  2 03:04:05 2001",
    });

    const registry = await loadShards(dir);

    expect(registry["recycled-agent"]).toBeUndefined();
    expect(existsSync(shardPath(dir, "recycled-agent"))).toBe(false);
  });

  it("loadShards keeps a legacy stampless shard whose pid is live", async () => {
    await writeFileSync(
      join(dir, "legacy-agent.json"),
      JSON.stringify(record("legacy-agent")),
      "utf8",
    );

    const registry = await loadShards(dir);

    expect(registry["legacy-agent"]).toMatchObject({ name: "legacy-agent", pid: process.pid });
  });
});

const globalRestores: Array<() => void> = [];

/** A kill(2) error carrying the given errno code. */
function killError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code.toLowerCase()), { code });
}

/** Route process.kill(pid, 0) for the listed pids to the given errors; every
 *  other pid keeps the real implementation. Restore runs in afterEach. */
function failKillFor(failures: Record<number, NodeJS.ErrnoException>): void {
  const originalKill = process.kill;
  globalRestores.push(() => {
    process.kill = originalKill;
  });
  process.kill = ((pid: number, signal?: string | number) => {
    const error = failures[pid];
    if (error !== undefined) throw error;
    return originalKill(pid, signal);
  }) as typeof process.kill;
}
