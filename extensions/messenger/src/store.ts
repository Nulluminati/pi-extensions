/**
 * File-backed messenger store under `<cwd>/.pi/messenger/`:
 * - registry.json   — live presence (agent name → presence record)
 * - reservations.json — path prefix → claim
 * - inbox/<name>.jsonl — per-agent mailbox, one JSON message per line
 *
 * All coordination is file-based; no daemon. Stale presence entries (dead
 * pids) are pruned on read. Writes are atomic per file; mailbox appends are
 * single-line JSONL.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Message, Presence, PresenceRegistry, ReservationMap } from "./types.ts";

// --- Paths ---

export function messengerDir(cwd: string): string {
  return join(cwd, ".pi", "messenger");
}

function registryPath(cwd: string): string {
  return join(messengerDir(cwd), "registry.json");
}

function registryDir(cwd: string): string {
  return join(messengerDir(cwd), "registry");
}

function agentShardPath(cwd: string, name: string): string {
  return join(registryDir(cwd), `${encodeURIComponent(name)}.json`);
}

function reservationsPath(cwd: string): string {
  return join(messengerDir(cwd), "reservations.json");
}

export function inboxPath(cwd: string, name: string): string {
  return join(messengerDir(cwd), "inbox", `${name}.jsonl`);
}

// --- Atomic JSON helpers ---

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
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

// --- Presence ---

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function loadRegistry(cwd: string): Promise<PresenceRegistry> {
  const registry: PresenceRegistry = {};

  // Migrate the legacy single-file registry to shards: one file per agent so
  // concurrent heartbeats never rewrite each other's entries (lost updates).
  const legacy = await readJson<PresenceRegistry>(registryPath(cwd));
  if (legacy) {
    for (const [name, presence] of Object.entries(legacy)) {
      registry[name] = presence;
      await writeJsonAtomic(agentShardPath(cwd, name), presence);
    }
    await unlink(registryPath(cwd)).catch(() => {});
  }

  let files: string[] = [];
  try {
    files = await readdir(registryDir(cwd));
  } catch {
    // No registry yet.
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const presence = await readJson<Presence>(join(registryDir(cwd), file));
    if (!presence || typeof presence.name !== "string" || typeof presence.pid !== "number") {
      // Corrupt shard: drop it rather than failing every read.
      await unlink(join(registryDir(cwd), file)).catch(() => {});
      continue;
    }
    registry[presence.name] = presence;
  }

  // Prune dead sessions by deleting their shard so `list` shows only live
  // agents and orphans cannot accumulate.
  for (const [name, presence] of Object.entries(registry)) {
    if (!isProcessAlive(presence.pid)) {
      await unlink(agentShardPath(cwd, name)).catch(() => {});
      delete registry[name];
    }
  }
  return registry;
}

export async function heartbeat(
  cwd: string,
  name: string,
  info: { pid: number; cwd: string; model?: string; status?: string },
): Promise<void> {
  // One shard per agent: this write never touches another agent's entry, so
  // concurrent heartbeats cannot clobber each other.
  const existing = await readJson<Presence>(agentShardPath(cwd, name));
  const model = info.model ?? existing?.model;
  const status = info.status ?? existing?.status;
  const presence: Presence = {
    name,
    pid: info.pid,
    cwd: info.cwd,
    ...(model !== undefined ? { model } : {}),
    ...(status !== undefined ? { status } : {}),
    startedAt: existing?.startedAt ?? Date.now(),
    lastSeenAt: Date.now(),
  };
  await writeJsonAtomic(agentShardPath(cwd, name), presence);
}

export async function leaveRegistry(cwd: string, name: string): Promise<void> {
  await unlink(agentShardPath(cwd, name)).catch(() => {});
}

// --- Mailbox ---

export async function sendMessage(
  cwd: string,
  to: string,
  from: string,
  text: string,
): Promise<Message> {
  const message: Message = {
    id: `msg-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
    from,
    to,
    text,
    at: Date.now(),
  };
  await mkdir(dirname(inboxPath(cwd, to)), { recursive: true });
  await appendFile(inboxPath(cwd, to), `${JSON.stringify(message)}\n`, "utf8");
  return message;
}

/** Unread messages for `name`, oldest first. */
export async function readInbox(cwd: string, name: string): Promise<Message[]> {
  let raw: string;
  try {
    raw = await readFile(inboxPath(cwd, name), "utf8");
  } catch {
    return [];
  }
  const messages: Message[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Message;
      if (parsed && typeof parsed.text === "string" && !parsed.read) messages.push(parsed);
    } catch {
      // Skip malformed lines rather than failing the whole mailbox.
    }
  }
  return messages;
}

/** Mark messages read by rewriting the mailbox without them. */
export async function markRead(cwd: string, name: string, ids: string[]): Promise<void> {
  const path = inboxPath(cwd, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  const idSet = new Set(ids);
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Message;
      if (!idSet.has(parsed.id)) kept.push(line);
    } catch {
      kept.push(line); // preserve malformed lines
    }
  }
  if (kept.length === 0) {
    await unlink(path).catch(() => {});
  } else {
    await writeFile(path, `${kept.join("\n")}\n`, "utf8");
  }
}

// --- Reservations ---

/** How long a claim whose owner is gone survives before pruning. Covers the
 *  gap between a session dying and its identity resuming (pi -c). */
const ORPHAN_TTL_MS = 10 * 60_000;

export async function loadReservations(cwd: string): Promise<ReservationMap> {
  const reservations = (await readJson<ReservationMap>(reservationsPath(cwd))) ?? {};
  const registry = await loadRegistry(cwd);
  let changed = false;
  const now = Date.now();
  for (const [prefix, claim] of Object.entries(reservations)) {
    if (claim.pid === undefined || isProcessAlive(claim.pid)) continue;
    if (registry[claim.owner] !== undefined) continue;
    // The owning process is gone and its identity has left the registry.
    // Stamp the first sighting and keep the claim for the grace window so
    // other sessions' reads cannot destroy it before a resume re-adopts it.
    if (claim.orphanedAt === undefined) {
      claim.orphanedAt = now;
      changed = true;
    } else if (now - claim.orphanedAt >= ORPHAN_TTL_MS) {
      delete reservations[prefix];
      changed = true;
    }
  }
  if (changed) await saveReservations(cwd, reservations);
  return reservations;
}

async function saveReservations(cwd: string, reservations: ReservationMap): Promise<void> {
  await writeJsonAtomic(reservationsPath(cwd), reservations);
}

/**
 * Normalize a user-supplied reservation or target path into a stable relative
 * prefix key (posix separators, relative to cwd). Absolute paths inside the
 * project are converted; paths outside the project are returned unresolved
 * (undefined) because reservations are project-scoped.
 */
export function normalizePathPrefix(cwd: string, raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return undefined;
  const abs = resolve(cwd, trimmed);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    // Empty rel means cwd itself; outside-project paths get ".."-prefixed rel.
    if (rel === "") return ".";
    return undefined;
  }
  const posix = rel.split(sep).join("/");
  return posix === "" ? "." : posix;
}

export async function reserve(
  cwd: string,
  name: string,
  paths: string[],
  reason?: string,
  pid?: number,
): Promise<{ reserved: string[]; conflicts: Array<{ path: string; owner: string }> }> {
  const reservations = await loadReservations(cwd);
  const reserved: string[] = [];
  const conflicts: Array<{ path: string; owner: string }> = [];
  for (const raw of paths) {
    const prefix = normalizePathPrefix(cwd, raw);
    if (prefix === undefined) {
      conflicts.push({ path: raw, owner: "(outside project)" });
      continue;
    }
    const existing = reservations[prefix];
    if (existing && existing.owner !== name) {
      conflicts.push({ path: prefix, owner: existing.owner });
      continue;
    }
    reservations[prefix] = {
      owner: name,
      ...(pid !== undefined ? { pid } : {}),
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      at: Date.now(),
    };
    reserved.push(prefix);
  }
  await saveReservations(cwd, reservations);
  return { reserved, conflicts };
}

/**
 * Re-adopt claims owned by `name` after a resume: update their pid to the
 * current process and clear any orphan mark so the grace window restarts.
 * Identities persist in the session (messenger-identity entry), so a resumed
 * session re-adopts what it held before it quit.
 */
export async function readoptReservations(cwd: string, name: string): Promise<void> {
  const reservations = await loadReservations(cwd);
  let changed = false;
  for (const claim of Object.values(reservations)) {
    if (claim.owner === name && (claim.pid !== process.pid || claim.orphanedAt !== undefined)) {
      claim.pid = process.pid;
      delete claim.orphanedAt;
      changed = true;
    }
  }
  if (changed) await saveReservations(cwd, reservations);
}

export async function release(cwd: string, name: string, paths?: string[]): Promise<string[]> {
  const reservations = await loadReservations(cwd);
  const released: string[] = [];
  for (const [prefix, claim] of Object.entries(reservations)) {
    if (claim.owner !== name) continue;
    if (paths === undefined) {
      delete reservations[prefix];
      released.push(prefix);
      continue;
    }
    const wanted = paths
      .map((p) => normalizePathPrefix(cwd, p))
      .filter((p): p is string => p !== undefined);
    if (wanted.includes(prefix)) {
      delete reservations[prefix];
      released.push(prefix);
    }
  }
  await saveReservations(cwd, reservations);
  return released;
}

export interface ReservationBlock {
  prefix: string;
  owner: string;
  reason?: string;
}

/**
 * Check whether a target file path is reserved by another agent. Target paths
 * are resolved against cwd and matched against reservation prefixes by
 * directory boundary (prefix `src/auth` matches `src/auth/login.ts` and
 * `src/auth/sub/x.ts`, not `src/auth2/x.ts`).
 */
export function findBlockingReservation(
  cwd: string,
  targetPath: string,
  selfName: string,
  reservations: ReservationMap,
): ReservationBlock | undefined {
  const prefix = normalizePathPrefix(cwd, targetPath);
  if (prefix === undefined) return undefined;
  for (const [key, claim] of Object.entries(reservations)) {
    if (claim.owner === selfName) continue;
    const covered = key === "." ? true : prefix === key || prefix.startsWith(`${key}/`);
    if (covered) {
      return {
        prefix: key,
        owner: claim.owner,
        ...(claim.reason !== undefined ? { reason: claim.reason } : {}),
      };
    }
  }
  return undefined;
}

/** Whether the project has a messenger directory (used by tests). */
export function messengerInitialized(cwd: string): boolean {
  return existsSync(messengerDir(cwd));
}
