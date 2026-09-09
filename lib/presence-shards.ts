/**
 * Sharded presence registry.
 *
 * Presence state shared by multiple live sessions must never be a single
 * JSON file: heartbeat is read-modify-write, and concurrent writers clobber
 * each other's entries (observed live: a session vanished from the roster
 * while online). One shard file per agent means each session only ever
 * writes its own entry; reads merge all shards and prune entries whose pid
 * is dead.
 *
 * A legacy single-file registry can be migrated to shards on first read by
 * passing its path as `legacyPath`.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// --- Types ---

export interface ShardRecord {
  name: string;
  pid: number;
}

export interface LoadShardsOptions {
  /** Legacy single-file registry migrated to shards on first read. */
  legacyPath?: string;
}

// --- Liveness ---

/** True when the pid belongs to a live process. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Paths ---

export function shardPath(dir: string, agentName: string): string {
  return join(dir, `${encodeURIComponent(agentName)}.json`);
}

// --- Atomic JSON helpers ---

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// --- Operations ---

/** Write one agent's shard. Never touches another agent's shard. */
export async function writeShard<T extends ShardRecord>(dir: string, record: T): Promise<void> {
  await writeJsonAtomic(shardPath(dir, record.name), record);
}

/** Read one agent's shard without side effects. */
export async function readShard<T extends ShardRecord>(
  dir: string,
  agentName: string,
): Promise<T | undefined> {
  return readJson<T>(shardPath(dir, agentName));
}

/** Delete one agent's shard, if present. */
export async function removeShard(dir: string, agentName: string): Promise<void> {
  await unlink(shardPath(dir, agentName)).catch(() => {});
}

/**
 * Read all shards, keyed by the stored name. Migrates a legacy single-file
 * registry when `legacyPath` is given, drops corrupt shards rather than
 * failing every read, and prunes (deletes) shards whose pid is dead so
 * orphans cannot accumulate.
 */
export async function loadShards<T extends ShardRecord>(
  dir: string,
  options?: LoadShardsOptions,
): Promise<Record<string, T>> {
  const registry: Record<string, T> = {};

  if (options?.legacyPath) {
    const legacy = await readJson<Record<string, T>>(options.legacyPath);
    if (legacy) {
      for (const record of Object.values(legacy)) {
        if (record && typeof record.name === "string") {
          registry[record.name] = record;
          await writeShard(dir, record);
        }
      }
      await unlink(options.legacyPath).catch(() => {});
    }
  }

  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    // No registry yet.
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = await readJson<T>(join(dir, file));
    if (!record || typeof record.name !== "string" || typeof record.pid !== "number") {
      await unlink(join(dir, file)).catch(() => {});
      continue;
    }
    registry[record.name] = record;
  }

  for (const [name, record] of Object.entries(registry)) {
    if (!isProcessAlive(record.pid)) {
      await removeShard(dir, name);
      delete registry[name];
    }
  }
  return registry;
}
