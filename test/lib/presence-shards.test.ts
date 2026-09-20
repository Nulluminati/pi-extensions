import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
});
