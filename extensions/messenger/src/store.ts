/**
 * File-backed messenger store under `<cwd>/.pi/messenger/`:
 * - registry/<name>.json — live presence, one shard per agent
 * - reservations.json — path prefix → claim, writes guarded by reservations.lock
 * - inbox/<name>.jsonl — per-agent mailbox, one JSON message per line; names
 *   are percent-encoded and writes are guarded by a per-mailbox lock
 *
 * All coordination is file-based; no daemon. Stale presence entries (dead
 * pids) are pruned on read. Writes are atomic per file; mailbox appends are
 * single-line JSONL.
 */

import { randomBytes } from "node:crypto";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir, projectStateRelative } from "../../../lib/paths.ts";
import {
  isProcessAlive,
  loadShards,
  readShard,
  removeShard,
  writeShard,
} from "../../../lib/presence-shards.ts";
import type { Message, Presence, PresenceRegistry, ReservationMap } from "./types.ts";

// --- Paths ---

export function messengerDir(cwd: string): string {
  return projectStateDir(cwd, "messenger");
}

function registryPath(cwd: string): string {
  return join(messengerDir(cwd), "registry.json");
}

function registryDir(cwd: string): string {
  return join(messengerDir(cwd), "registry");
}

function reservationsPath(cwd: string): string {
  return join(messengerDir(cwd), "reservations.json");
}

function reservationsLockPath(cwd: string): string {
  return join(messengerDir(cwd), "reservations.lock");
}

function mailboxLockPath(cwd: string, name: string): string {
  return join(messengerDir(cwd), "inbox", `${encodeURIComponent(name)}.lock`);
}

/** Mailbox filename for an agent name. Percent-encoding keeps a recipient
 *  like "../escape" from addressing a file outside the inbox directory. */
export function inboxFileName(name: string): string {
  return `${encodeURIComponent(name)}.jsonl`;
}

export function inboxPath(cwd: string, name: string): string {
  return join(messengerDir(cwd), "inbox", inboxFileName(name));
}

// --- Error helpers ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Presence ---

export async function loadRegistry(cwd: string): Promise<PresenceRegistry> {
  // Sharded registry: one file per agent, dead pids pruned on read, legacy
  // single-file registry migrated on first read. All in lib/presence-shards.
  return loadShards<Presence>(registryDir(cwd), { legacyPath: registryPath(cwd) });
}

export async function heartbeat(
  cwd: string,
  name: string,
  info: { pid: number; cwd: string; model?: string; status?: string },
): Promise<void> {
  // One shard per agent: this write never touches another agent's entry, so
  // concurrent heartbeats cannot clobber each other. An empty-string status
  // clears the field; an omitted one (undefined) keeps the existing value.
  const existing = await readShard<Presence>(registryDir(cwd), name);
  const model = info.model ?? existing?.model;
  const status =
    info.status === undefined ? existing?.status : info.status === "" ? undefined : info.status;
  const presence: Presence = {
    name,
    pid: info.pid,
    cwd: info.cwd,
    ...(model !== undefined ? { model } : {}),
    ...(status !== undefined ? { status } : {}),
    startedAt: existing?.startedAt ?? Date.now(),
    lastSeenAt: Date.now(),
  };
  await writeShard(registryDir(cwd), presence);
}

export async function leaveRegistry(cwd: string, name: string): Promise<void> {
  await removeShard(registryDir(cwd), name);
}

/** How many `-2`, `-3`, … suffixes to try before giving up. */
const MAX_NAME_ATTEMPTS = 100;

/**
 * Return an agent name not held by a different live process: `name` when it
 * is free (or held by this pid), otherwise the first free `name-2`, `name-3`,
 * …. Deterministic, so two sessions racing to join converge on distinct
 * mailboxes instead of fighting over one name.
 */
export async function ensureUniqueAgentName(
  cwd: string,
  name: string,
  pid: number = process.pid,
): Promise<string> {
  let candidate = name;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const holder = (await loadRegistry(cwd))[candidate];
    if (holder === undefined || holder.pid === pid || !isProcessAlive(holder.pid)) {
      return candidate;
    }
    candidate = `${name}-${attempt + 1}`;
  }
  throw new Error(
    `No free agent name derived from "${name}" after ${MAX_NAME_ATTEMPTS} attempts; ` +
      `stale sessions may be holding the registry — check ${projectStateRelative("messenger")}/registry/.`,
  );
}

// --- Mailbox ---

const MAX_MAILBOX_NAME_LENGTH = 200;

/**
 * Reject mailbox identities that cannot be a single path segment even after
 * percent-encoding (separators, NUL) or that are empty/absurdly long. Name
 * encoding alone keeps traversal inside the inbox; validation fails closed
 * at the address boundary instead of creating a mailbox nobody can read.
 */
function assertValidMailboxName(name: string): void {
  if (!name || name.length > MAX_MAILBOX_NAME_LENGTH || /[\\/\0]/.test(name)) {
    throw new Error(`Invalid recipient mailbox name: ${JSON.stringify(name)}`);
  }
}

export async function sendMessage(
  cwd: string,
  to: string,
  from: string,
  text: string,
): Promise<Message> {
  assertValidMailboxName(to);
  const message: Message = {
    // 8 random bytes: markRead deletes every message matching an id it is
    // given, so a duplicate id would silently drop unread mail. Two bytes
    // collided inside a single busy millisecond (30-message bursts hit this
    // in practice); 64 bits makes a same-millisecond collision negligible.
    id: `msg-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`,
    from,
    to,
    text,
    at: Date.now(),
  };
  // Appends take the mailbox lock so a concurrent markRead cannot read the
  // mailbox before this append and rename the file without it after.
  await withFileLock(mailboxLockPath(cwd, to), async () => {
    await appendFile(inboxPath(cwd, to), `${JSON.stringify(message)}\n`, "utf8");
  });
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
  if (ids.length === 0) return;
  const path = inboxPath(cwd, name);
  // The lock makes read-filter-write atomic with sendMessage appends: mail
  // arriving while we compact is appended after our rename and stays unread.
  await withFileLock(mailboxLockPath(cwd, name), async () => {
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
      return;
    }
    const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
    await writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
    await rename(tmp, path);
  });
}

// --- Reservations ---

/** How long a claim whose owner is gone survives before pruning. Covers the
 *  gap between a session dying and its identity resuming (pi -c). */
const ORPHAN_TTL_MS = 10 * 60_000;

export async function loadReservations(cwd: string): Promise<ReservationMap> {
  return withFileLock(reservationsLockPath(cwd), () => loadReservationsUnlocked(cwd));
}

/**
 * Read the reservations map. A missing file is an empty map; a corrupt file
 * or failed read throws naming the path, so callers fail loudly instead of
 * silently treating enforcement as disabled (the next save would then wipe
 * every live claim).
 */
async function readReservations(cwd: string): Promise<ReservationMap> {
  const path = reservationsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`Cannot read messenger reservations at ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(raw) as ReservationMap;
  } catch (error) {
    throw new Error(`Messenger reservations file at ${path} is corrupt: ${errorMessage(error)}`);
  }
}

async function loadReservationsUnlocked(cwd: string): Promise<ReservationMap> {
  const reservations = await readReservations(cwd);
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
  // ".."-prefixed rels are outside the project; the separator check keeps
  // top-level entries that merely start with dots ("..notes", "...") inside.
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    // Empty rel means cwd itself.
    if (rel === "") return ".";
    return undefined;
  }
  const posix = rel.split(sep).join("/");
  return posix === "" ? "." : posix;
}

/**
 * Whether two normalized path prefixes cover any of the same tree: equal,
 * one nested under the other, or either being the project root (".").
 */
function overlapsPrefix(a: string, b: string): boolean {
  if (a === "." || b === ".") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function findOverlappingOwner(
  reservations: ReservationMap,
  prefix: string,
  selfName: string,
): string | undefined {
  for (const [key, claim] of Object.entries(reservations)) {
    if (claim.owner === selfName) continue;
    if (overlapsPrefix(prefix, key)) return claim.owner;
  }
  return undefined;
}

export async function reserve(
  cwd: string,
  name: string,
  paths: string[],
  reason?: string,
  pid?: number,
): Promise<{ reserved: string[]; conflicts: Array<{ path: string; owner: string }> }> {
  return withFileLock(reservationsLockPath(cwd), async () => {
    const reservations = await loadReservationsUnlocked(cwd);
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
      // Claims may not overlap an ancestor or descendant claim held by
      // another agent, so reservation matching stays unambiguous.
      const overlappingOwner = findOverlappingOwner(reservations, prefix, name);
      if (overlappingOwner) {
        conflicts.push({ path: prefix, owner: overlappingOwner });
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
    if (reserved.length > 0) await saveReservations(cwd, reservations);
    return { reserved, conflicts };
  });
}

/**
 * Re-adopt claims owned by `name` after a resume: update their pid to the
 * current process and clear any orphan mark so the grace window restarts.
 * Identities persist in the session (messenger-identity entry), so a resumed
 * session re-adopts what it held before it quit.
 */
export async function readoptReservations(cwd: string, name: string): Promise<void> {
  await withFileLock(reservationsLockPath(cwd), async () => {
    const reservations = await loadReservationsUnlocked(cwd);
    let changed = false;
    for (const claim of Object.values(reservations)) {
      if (claim.owner === name && (claim.pid !== process.pid || claim.orphanedAt !== undefined)) {
        claim.pid = process.pid;
        delete claim.orphanedAt;
        changed = true;
      }
    }
    if (changed) await saveReservations(cwd, reservations);
  });
}

export async function release(cwd: string, name: string, paths?: string[]): Promise<string[]> {
  return withFileLock(reservationsLockPath(cwd), async () => {
    const reservations = await loadReservationsUnlocked(cwd);
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
    if (released.length > 0) await saveReservations(cwd, reservations);
    return released;
  });
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
