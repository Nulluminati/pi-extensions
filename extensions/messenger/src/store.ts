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
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
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
  // Workers keep file paths relative to their worktree, but share the
  // parent's mailbox and presence state across worktrees.
  const root =
    process.env.PI_WORKER === "1" ? process.env.PI_MESSENGER_PROJECT_ROOT?.trim() : undefined;
  if (root) {
    if (!isAbsolute(root)) throw new Error("Worker messenger project root must be absolute");
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Worker messenger project root is not a directory: ${root}`);
    }
    return projectStateDir(root, "messenger");
  }
  return projectStateDir(cwd, "messenger");
}

function registryPath(cwd: string): string {
  return join(messengerDir(cwd), "registry.json");
}

function registryDir(cwd: string): string {
  return join(messengerDir(cwd), "registry");
}

/** Cross-process lock guarding claim-time read-modify-write over the
 *  registry: two sessions picking an agent name at once must not both see
 *  the same candidate free. */
function registryLockPath(cwd: string): string {
  return join(messengerDir(cwd), "registry.json.lock");
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

/** Sibling of the mailbox holding lines that failed JSON.parse, byte for
 *  byte, so corruption stays visible and recoverable instead of being
 *  silently skipped or rewritten away. */
function quarantinePath(cwd: string, name: string): string {
  return `${inboxPath(cwd, name)}.quarantine`;
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
  throw noFreeNameError(name);
}

function noFreeNameError(name: string): Error {
  return new Error(
    `No free agent name derived from "${name}" after ${MAX_NAME_ATTEMPTS} attempts; ` +
      `stale sessions may be holding the registry — check ${projectStateRelative("messenger")}/registry/.`,
  );
}

/**
 * Atomically claim an agent identity: the candidate-selection loop runs
 * inside the registry lock and the chosen name's presence shard is written
 * before the lock is released, so a concurrent claim observes the claim and
 * moves to the next suffix instead of sharing a mailbox and reservation
 * identity. Dead holders are pruned on read, so a name whose session died is
 * reusable; a live holder pushes the claim to `name-2`, `name-3`, ….
 */
export async function claimIdentity(
  cwd: string,
  name: string,
  pid: number = process.pid,
): Promise<string> {
  return withFileLock(registryLockPath(cwd), async () => {
    const registry = await loadRegistry(cwd);
    let candidate = name;
    let claimed = false;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const holder = registry[candidate];
      if (holder === undefined || holder.pid === pid || !isProcessAlive(holder.pid)) {
        claimed = true;
        break;
      }
      candidate = `${name}-${attempt + 2}`;
    }
    if (!claimed) throw noFreeNameError(name);
    // Durable before the lock releases: the shard is on disk, so the next
    // claim's candidate loop cannot see the name as free.
    await writeShard(registryDir(cwd), {
      name: candidate,
      pid,
      cwd,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return candidate;
  });
}

// --- Mailbox ---

const MAX_MAILBOX_NAME_LENGTH = 200;

/**
 * 8 random bytes: markRead deletes every message matching an id it is given,
 * so a duplicate id would silently drop unread mail. Two bytes collided
 * inside a single busy millisecond (30-message bursts hit this in practice);
 * 64 bits makes a same-millisecond collision negligible.
 */
export function generateMessageId(): string {
  return `msg-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

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

/** Splits JSONL content into non-blank lines, keeping both the trimmed text
 *  (for parsing) and the original bytes including the newline (so malformed
 *  lines can be moved to quarantine exactly as they were written). */
function jsonlLines(raw: string): Array<{ text: string; bytes: string }> {
  const lines: Array<{ text: string; bytes: string }> = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline === -1 ? raw.length : newline;
    const text = raw.slice(start, end);
    if (text.trim()) {
      lines.push({ text, bytes: raw.slice(start, newline === -1 ? end : newline + 1) });
    }
    start = newline === -1 ? raw.length : newline + 1;
  }
  return lines;
}

export async function sendMessage(
  cwd: string,
  to: string,
  from: string,
  text: string,
): Promise<Message> {
  assertValidMailboxName(to);
  const message: Message = {
    id: generateMessageId(),
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

/** One inbox read: the still-unread messages, plus how many malformed lines
 *  this read moved into quarantine. */
export interface InboxRead {
  unread: Message[];
  quarantined: number;
}

/** Unread messages for `name`, oldest first. Only a missing mailbox reads as
 *  empty; an unreadable one fails visibly, so delivery never mistakes a
 *  broken mailbox for an empty one and later compaction cannot destroy it.
 *  Malformed lines are not skipped: they are moved byte for byte into the
 *  sibling `<mailbox>.quarantine` file (delivery continues, corruption stays
 *  visible), and `quarantined` reports how many lines this read moved. */
export async function readInbox(cwd: string, name: string): Promise<InboxRead> {
  const path = inboxPath(cwd, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { unread: [], quarantined: 0 };
    }
    throw new Error(`Mailbox ${path} is unreadable: ${String(error)}`);
  }
  const messages: Message[] = [];
  let malformed = false;
  for (const { text } of jsonlLines(raw)) {
    try {
      const parsed = JSON.parse(text) as Message;
      if (parsed && typeof parsed.text === "string" && !parsed.read) messages.push(parsed);
    } catch {
      malformed = true;
    }
  }
  if (!malformed) return { unread: messages, quarantined: 0 };
  // Quarantine under the mailbox lock so the rewrite cannot race sendMessage
  // appends or markRead compaction. The locked body re-reads the mailbox, so
  // mail appended since the unlocked scan above is never touched.
  const quarantined = await withFileLock(mailboxLockPath(cwd, name), () =>
    quarantineMalformedLocked(cwd, name),
  );
  return { unread: messages, quarantined };
}

/** Move every malformed line of the mailbox into the sibling quarantine file
 *  and rewrite the mailbox without them. Caller holds the mailbox lock.
 *  Returns the number of lines moved; zero when the mailbox is already
 *  clean, so repeated reads never append duplicate quarantine entries. */
async function quarantineMalformedLocked(cwd: string, name: string): Promise<number> {
  const path = inboxPath(cwd, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return 0;
    throw new Error(`Mailbox ${path} is unreadable: ${String(error)}`);
  }
  const kept: string[] = [];
  const malformed: string[] = [];
  for (const { text, bytes } of jsonlLines(raw)) {
    try {
      JSON.parse(text);
      kept.push(text);
    } catch {
      malformed.push(bytes);
    }
  }
  if (malformed.length === 0) return 0;
  await appendFile(quarantinePath(cwd, name), malformed.join(""), "utf8");
  if (kept.length === 0) {
    await unlink(path).catch(() => {});
    return malformed.length;
  }
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
  await rename(tmp, path);
  return malformed.length;
}

/** Mark messages read by rewriting the mailbox without them. Malformed lines
 *  met during compaction move to the quarantine file instead of being
 *  preserved in place. */
export async function markRead(cwd: string, name: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const path = inboxPath(cwd, name);
  // The lock makes read-filter-write atomic with sendMessage appends: mail
  // arriving while we compact is appended after our rename and stays unread.
  await withFileLock(mailboxLockPath(cwd, name), async () => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
      throw new Error(`Mailbox ${path} is unreadable: ${String(error)}`);
    }
    const idSet = new Set(ids);
    const kept: string[] = [];
    const malformed: string[] = [];
    for (const { text, bytes } of jsonlLines(raw)) {
      try {
        const parsed = JSON.parse(text) as Message;
        if (!idSet.has(parsed.id)) kept.push(text);
      } catch {
        malformed.push(bytes); // corrupted lines move to quarantine below
      }
    }
    if (malformed.length > 0) {
      await appendFile(quarantinePath(cwd, name), malformed.join(""), "utf8");
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

// --- Filesystem case policy ---

/**
 * Override for the reservation matchers' filesystem case behavior: `true`
 * compares path prefixes without case (case-insensitive volume), `false`
 * compares exactly. When omitted, the policy is detected from the filesystem
 * backing the project state directory — a macOS volume can be either flavor,
 * so the volume is measured, never inferred from the operating system.
 */
export interface CaseFoldOptions {
  caseInsensitiveFs?: boolean;
}

const CASE_PROBE_TTL_MS = 60_000;
/** Memoized probe result, not coordination state: a wrong entry expires with
 *  the TTL and only skips re-measuring an unchanged volume. */
let caseProbeCache: { dir: string; insensitive: boolean; at: number } | undefined;

/**
 * Whether the filesystem backing `dir` treats names differing only by case as
 * one file. Probes by creating a uniquely named file and looking for its
 * case-flipped twin; a failed probe folds case to avoid missing a held path.
 * Cached briefly per directory: a probe costs one file create per TTL window.
 */
function isCaseInsensitiveVolume(dir: string): boolean {
  const now = Date.now();
  if (caseProbeCache && caseProbeCache.dir === dir && now - caseProbeCache.at < CASE_PROBE_TTL_MS) {
    return caseProbeCache.insensitive;
  }
  let insensitive = true;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = `case-probe-${process.pid}-${randomBytes(4).toString("hex")}`;
    const handle = openSync(join(dir, probe), "wx", 0o600);
    try {
      try {
        statSync(join(dir, probe.toUpperCase()));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") insensitive = false;
        else throw error;
      }
    } finally {
      closeSync(handle);
      unlinkSync(join(dir, probe));
    }
  } catch {
    insensitive = true;
  }
  caseProbeCache = { dir, insensitive, at: now };
  return insensitive;
}

/** Effective fold policy for one reservation operation. */
function resolveCaseFold(cwd: string, options?: CaseFoldOptions): boolean {
  if (options?.caseInsensitiveFs !== undefined) return options.caseInsensitiveFs;
  try {
    return isCaseInsensitiveVolume(messengerDir(cwd));
  } catch {
    return true;
  }
}

/** Fold a normalized or stored prefix for comparison under the fold policy. */
function foldKey(key: string, fold: boolean): string {
  return fold ? key.toLowerCase() : key;
}

/** The stored key that covers `prefix` under the fold policy, if any. */
function findStoredKey(
  reservations: ReservationMap,
  prefix: string,
  fold: boolean,
): string | undefined {
  if (!fold) return prefix in reservations ? prefix : undefined;
  const folded = foldKey(prefix, true);
  for (const key of Object.keys(reservations)) {
    if (foldKey(key, true) === folded) return key;
  }
  return undefined;
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
 * one nested under the other, or either being the project root ("."). Under
 * the fold policy both sides are compared case-insensitively.
 */
function overlapsPrefix(a: string, b: string, fold = false): boolean {
  const fa = foldKey(a, fold);
  const fb = foldKey(b, fold);
  if (fa === "." || fb === ".") return true;
  return fa === fb || fa.startsWith(`${fb}/`) || fb.startsWith(`${fa}/`);
}

function findOverlappingOwner(
  reservations: ReservationMap,
  prefix: string,
  selfName: string,
  fold = false,
): string | undefined {
  for (const [key, claim] of Object.entries(reservations)) {
    if (claim.owner === selfName) continue;
    if (overlapsPrefix(prefix, key, fold)) return claim.owner;
  }
  return undefined;
}

export async function reserve(
  cwd: string,
  name: string,
  paths: string[],
  reason?: string,
  pid?: number,
  options?: CaseFoldOptions,
): Promise<{ reserved: string[]; conflicts: Array<{ path: string; owner: string }> }> {
  return withFileLock(reservationsLockPath(cwd), async () => {
    const reservations = await loadReservationsUnlocked(cwd);
    const fold = resolveCaseFold(cwd, options);
    const reserved: string[] = [];
    const conflicts: Array<{ path: string; owner: string }> = [];
    for (const raw of paths) {
      const prefix = normalizePathPrefix(cwd, raw);
      if (prefix === undefined) {
        conflicts.push({ path: raw, owner: "(outside project)" });
        continue;
      }
      // An existing claim covering this prefix is matched under the fold
      // policy and keeps its original stored key, so one path never holds
      // two keys that differ only by case.
      const storedKey = findStoredKey(reservations, prefix, fold);
      const existing = storedKey === undefined ? undefined : reservations[storedKey];
      if (existing && existing.owner !== name) {
        conflicts.push({ path: prefix, owner: existing.owner });
        continue;
      }
      // Claims may not overlap an ancestor or descendant claim held by
      // another agent, so reservation matching stays unambiguous.
      const overlappingOwner = findOverlappingOwner(reservations, prefix, name, fold);
      if (overlappingOwner) {
        conflicts.push({ path: prefix, owner: overlappingOwner });
        continue;
      }
      reservations[storedKey ?? prefix] = {
        owner: name,
        ...(pid !== undefined ? { pid } : {}),
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
        at: Date.now(),
      };
      reserved.push(storedKey ?? prefix);
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

export async function release(
  cwd: string,
  name: string,
  paths?: string[],
  options?: CaseFoldOptions,
): Promise<string[]> {
  return withFileLock(reservationsLockPath(cwd), async () => {
    const reservations = await loadReservationsUnlocked(cwd);
    const fold = resolveCaseFold(cwd, options);
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
        .filter((p): p is string => p !== undefined)
        .map((p) => foldKey(p, fold));
      if (wanted.includes(foldKey(prefix, fold))) {
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
 * `src/auth/sub/x.ts`, not `src/auth2/x.ts`). Under the fold policy (detected
 * from the volume, or forced via `options`) both sides compare without case,
 * so `Docs` and `docs` match on a case-insensitive filesystem.
 */
export function findBlockingReservation(
  cwd: string,
  targetPath: string,
  selfName: string,
  reservations: ReservationMap,
  options?: CaseFoldOptions,
): ReservationBlock | undefined {
  const prefix = normalizePathPrefix(cwd, targetPath);
  if (prefix === undefined) return undefined;
  const fold = resolveCaseFold(cwd, options);
  const needle = foldKey(prefix, fold);
  for (const [key, claim] of Object.entries(reservations)) {
    if (claim.owner === selfName) continue;
    const stored = foldKey(key, fold);
    const covered = stored === "." ? true : needle === stored || needle.startsWith(`${stored}/`);
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
