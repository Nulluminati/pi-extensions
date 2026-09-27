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

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./json-atomic.ts";

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

/** True when the pid belongs to a live process. signal 0 throws EPERM when
 *  the process exists but the caller cannot signal it (another user's
 *  session, a sandbox): that is a live process, so it must never be pruned
 *  like a dead one. Any other error keeps the conservative dead result. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

// --- Paths ---

export function shardPath(dir: string, agentName: string): string {
  return join(dir, `${encodeURIComponent(agentName)}.json`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// --- JSON helpers ---

/** Read one shard, distinguishing "absent" from "broken": only ENOENT (or
 *  ENOTDIR, a missing parent) returns undefined. A corrupt or unreadable
 *  shard must fail visibly — silently reading it as absent lets a later
 *  write overwrite durable presence with fresh state. */
async function readJson<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw new Error(`Presence shard ${path} is unreadable: ${String(error)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Presence shard ${path} is corrupt (invalid JSON): ${String(error)}`);
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
  } catch (error) {
    // No registry yet (ENOENT, or ENOTDIR for a missing parent). Any other
    // error must fail visibly: an unreadable registry must not read as an
    // empty one, or a later write can clobber durable presence.
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
      throw new Error(`Presence registry ${dir} is unreadable: ${String(error)}`);
    }
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const record = await readJson<T>(path);
    // A record that parses but does not match the shard shape is just as
    // broken as invalid JSON: refuse loudly instead of pruning it like a
    // dead session's shard — deletion is how durable presence gets destroyed
    // by a read.
    if (!record || typeof record.name !== "string" || typeof record.pid !== "number") {
      throw new Error(`Presence shard ${path} does not match the shard shape.`);
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
