/**
 * Session-scoped worker state.
 *
 * The owning session's transcript is the source of truth for its workers:
 * every state transition appends a `worker-record` custom entry (restored by
 * `pi -c`/`-r` with the session), so ownership needs no registry. Project
 * disk keeps only per-worker artifact files — `records/<id>.json` (metadata
 * written by the owning session alone, carrying the parent pid so a later
 * session can classify leftovers), the `streams/<id>.jsonl` spool, the
 * `streams/<id>.stderr.log` capture, and `patches/<id>.diff`. No shared
 * mutable registry, no cross-process
 * read-modify-write; the only lock left guards a collect's recordedBy write.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../../lib/errors.ts";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir } from "../../../lib/paths.ts";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import { assertWorkerId, isWorkerId } from "./ids.ts";
import type { WorkerRecord } from "./types.ts";
import { discardWorktree, worktreesDir } from "./worktree.ts";

// --- Retention ---

/** How long terminal-record artifacts are kept (counted from endedAt):
 *  record.json, stream, and patch are purged past this age. Running
 *  records are never pruned. */
export const WORKER_RETENTION_MS = 7 * 24 * 60 * 60_000;

// --- Paths ---

export function workersDir(cwd: string): string {
  return projectStateDir(cwd, "workers");
}

export function recordsDir(cwd: string): string {
  return join(workersDir(cwd), "records");
}

export function recordPath(cwd: string, workerId: string): string {
  return join(recordsDir(cwd), `${assertWorkerId(workerId)}.json`);
}

export function patchesDir(cwd: string): string {
  return join(workersDir(cwd), "patches");
}

export function patchPath(cwd: string, workerId: string): string {
  return join(patchesDir(cwd), `${assertWorkerId(workerId)}.diff`);
}

/** Per-worker stream projection (filtered event log for the tail action). */
export function streamsDir(cwd: string): string {
  return join(workersDir(cwd), "streams");
}

export function streamPath(cwd: string, workerId: string): string {
  return join(streamsDir(cwd), `${assertWorkerId(workerId)}.jsonl`);
}

/** Child stderr capture: written by the child itself (survives parent
 *  death), read for failure detail at finalization. */
export function stderrLogPath(cwd: string, workerId: string): string {
  return join(streamsDir(cwd), `${assertWorkerId(workerId)}.stderr.log`);
}

/** Nominal stream spool size. No writer enforces this cap: a chatty worker
 *  can grow its spool past it before its hard timeout fires. Readers bound
 *  themselves instead — the tail display and finalization read at most the
 *  last STREAM_TAIL_BYTES (runner.ts) of the file. */
export const STREAM_MAX_BYTES = 512 * 1024;

/** Per-record lock: sérialise le read-modify-write de collect sur le
 *  record.json d'un worker étranger (l'owner n'écrit jamais via ce lock ;
 *  ses writes sont single-writer par construction). */
function recordLockPath(cwd: string, workerId: string): string {
  return join(recordsDir(cwd), `${assertWorkerId(workerId)}.lock`);
}

/** Transcript custom entry type carrying worker records. */
export const WORKER_RECORD_ENTRY = "worker-record";

/** Transcript custom entry type marking a worker id as removed. Refresh
 *  replay treats it as a delete for its id: entries before it are shadowed,
 *  a later record entry re-adds the id (last-wins). Without it, a remove
 *  could not keep a deleted id absent — transcript entries are immutable
 *  history, so the record entry alone would resurrect on every reload. */
export const WORKER_REMOVED_ENTRY = "worker-removed";

// --- Ids ---

export function generateWorkerId(): string {
  // 8 random bytes: parallel delegates create ids within the same
  // millisecond, and 2 bytes collide too easily in that window.
  return `w-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

// --- Transcript records (ownership) ---

function isWorkerRecord(value: unknown): value is WorkerRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    isWorkerId((value as WorkerRecord).id) &&
    typeof (value as WorkerRecord).status === "string"
  );
}

/**
 * Reconstruct the calling session's workers from its transcript branch.
 * Entries are append-only state transitions; the last entry per worker id
 * wins — record entries upsert, removal markers delete. Corrupt or foreign
 * entries are ignored.
 */
export function loadWorkersFromBranch(branch: unknown[]): Map<string, WorkerRecord> {
  const workers = new Map<string, WorkerRecord>();
  for (const entry of branch) {
    const candidate = entry as { type?: string; customType?: string; data?: unknown };
    if (candidate?.type !== "custom") continue;
    if (candidate.customType === WORKER_REMOVED_ENTRY) {
      const marker = candidate.data as { id?: unknown } | undefined;
      if (typeof marker?.id === "string") workers.delete(marker.id);
      continue;
    }
    if (candidate.customType !== WORKER_RECORD_ENTRY) continue;
    if (!isWorkerRecord(candidate.data)) continue;
    workers.set(candidate.data.id, candidate.data);
  }
  return workers;
}

// --- Artifact record files (janitor metadata) ---

/** Write one worker's artifact metadata file. Single-writer: only the
 *  owning session writes its own records, except collect (locked). */
export async function writeRecordFile(cwd: string, record: WorkerRecord): Promise<void> {
  await writeJsonAtomic(recordPath(cwd, record.id), record);
}

/** Read one worker's artifact metadata file. */
export async function readRecordFile(
  cwd: string,
  workerId: string,
): Promise<WorkerRecord | undefined> {
  assertWorkerId(workerId);
  try {
    const raw = await readFile(recordPath(cwd, workerId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isWorkerRecord(parsed) && parsed.id === workerId ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    return undefined;
  }
}

/**
 * Read-modify-write over a record file, serialized per worker. Used where a
 * session other than the owner legitimately updates metadata (collect).
 */
export async function updateRecordFile(
  cwd: string,
  workerId: string,
  update: (record: WorkerRecord) => WorkerRecord,
): Promise<WorkerRecord> {
  return withFileLock(recordLockPath(cwd, workerId), async () => {
    const existing = await readRecordFile(cwd, workerId);
    if (!existing) throw new Error(`No artifact record for worker ${workerId}.`);
    const updated = update(existing);
    await writeRecordFile(cwd, updated);
    return updated;
  });
}

/** Every worker artifact record on disk, corrupt files skipped. */
export async function listRecordFiles(cwd: string): Promise<WorkerRecord[]> {
  let files: string[] = [];
  try {
    files = await readdir(recordsDir(cwd));
  } catch {
    return [];
  }
  const records: WorkerRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    if (!isWorkerId(id)) continue;
    const record = await readRecordFile(cwd, id);
    if (record) records.push(record);
  }
  return records;
}

// --- Persistence (composition root) ---

/** Persistence queues per cwd: the running-snapshot save and the terminal
 *  save can race inside one process when a child exits mid-bookkeeping;
 *  the queue keeps transcript and artifact file order stable. */
const persistQueues = new Map<string, Promise<unknown>>();

/** Removal tombstones for this process, keyed by cwd: saves for a removed
 *  id are refused at execution time, when the queue guarantees the removal
 *  (artifact deletion + transcript marker) has already run. Transcript
 *  markers cover replay after restart; this set covers the in-process race
 *  between a terminal save and a remove. */
const removedWorkers = new Map<string, Set<string>>();

/**
 * Persist one worker state transition: a transcript entry in the owning
 * session (ownership) plus the artifact metadata file (janitor). Returns
 * false when a late running snapshot would clobber a terminal state, or
 * when the worker was removed in this process — either way the caller must
 * not adopt the record into its in-memory cache.
 */
export function persistWorkerRecord(
  appendEntry: (customType: string, data: unknown) => void,
  cwd: string,
  worker: WorkerRecord,
): Promise<boolean> {
  const task = (persistQueues.get(cwd) ?? Promise.resolve())
    .then(async () => {
      // A queued terminal save must not re-add a worker whose removal is
      // already ordered ahead of it on this queue.
      if (removedWorkers.get(cwd)?.has(worker.id)) return false;
      const existing = await readRecordFile(cwd, worker.id);
      if (existing && existing.status !== "running" && worker.status === "running") {
        return false; // Terminal state already durable; a stale running snapshot loses.
      }
      appendEntry(WORKER_RECORD_ENTRY, worker);
      await writeRecordFile(cwd, worker);
      return true;
    })
    .catch((error) => {
      // Persistence failure must not crash the runner; surface loudly.
      console.error(`[workers] worker record persistence failed: ${(error as Error).message}`);
      throw error;
    });
  persistQueues.set(
    cwd,
    task.catch(() => {}),
  );
  return task;
}

/**
 * Persist a worker removal: artifact cleanup plus a `worker-removed`
 * transcript marker, ordered on the same persistence queue as record saves
 * so a queued terminal save cannot land after the marker and resurrect the
 * worker on the next replay. Only for workers this session's transcript
 * owns (the marker governs this session's replay); orphans and foreign
 * workers get artifact cleanup only.
 */
export function persistWorkerRemoval(
  appendEntry: (customType: string, data: unknown) => void,
  cwd: string,
  workerId: string,
): Promise<void> {
  const task = (persistQueues.get(cwd) ?? Promise.resolve())
    .then(async () => {
      await removeWorkerRecord(cwd, workerId);
      appendEntry(WORKER_REMOVED_ENTRY, { id: workerId, removedAt: Date.now() });
      let tombstones = removedWorkers.get(cwd);
      if (!tombstones) {
        tombstones = new Set<string>();
        removedWorkers.set(cwd, tombstones);
      }
      tombstones.add(workerId);
    })
    .catch((error) => {
      console.error(`[workers] worker removal persistence failed: ${(error as Error).message}`);
      throw error;
    });
  persistQueues.set(
    cwd,
    task.catch(() => {}),
  );
  return task;
}

// --- Janitor ---

/** Classification of artifact records left by other sessions. */
export interface ArtifactSweep {
  /** Live parent session: theirs, whatever the status. */
  foreignLive: WorkerRecord[];
  /** Running but parent session dead: alive right now, killable, watched
   *  for finalization by the sweeping session. */
  liveOrphans: WorkerRecord[];
  /** Terminal records whose owning session is gone (or predates
   *  ownership): collectable, silent, drained by retention. */
  terminalOrphans: WorkerRecord[];
  /** Worktree directories with no record file at all (record pruned or
   *  lost). Removable by id via workers (action=remove). */
  unownedWorktrees: string[];
}

/**
 * Classify project artifact records from this session's point of view.
 * Records belonging to this session (its transcript owns them) are skipped;
 * a record whose parent pid is still alive belongs to a live session;
 * everything else is an orphan left by an ended session.
 */
export async function sweepWorkerArtifacts(
  cwd: string,
  myWorkerIds: ReadonlySet<string>,
): Promise<ArtifactSweep> {
  const sweep: ArtifactSweep = {
    foreignLive: [],
    liveOrphans: [],
    terminalOrphans: [],
    unownedWorktrees: [],
  };
  const recorded = new Set<string>();
  for (const record of await listRecordFiles(cwd)) {
    recorded.add(record.id);
    if (myWorkerIds.has(record.id)) continue;
    const parentAlive = record.parentPid !== undefined && isProcessAlive(record.parentPid);
    if (parentAlive) {
      sweep.foreignLive.push(record);
      continue;
    }
    if (record.status === "running") {
      const workerAlive = record.pid !== undefined && isProcessAlive(record.pid);
      if (workerAlive) sweep.liveOrphans.push(record);
      // Running with a dead worker pid is NOT classified here: it is a
      // finalization candidate (finalizeStaleWorkers) and disappears from
      // the sweep once terminalized.
      continue;
    }
    sweep.terminalOrphans.push(record);
  }
  // Worktree dirs whose record file is gone: the 7-day purge deletes the
  // record while the worktree can survive a failed git removal, and legacy
  // states may never have had one on this layout.
  let entries: string[] = [];
  try {
    entries = await readdir(worktreesDir(cwd));
  } catch {
    return sweep;
  }
  for (const id of entries) {
    if (!recorded.has(id)) sweep.unownedWorktrees.push(id);
  }
  return sweep;
}

// --- Retention ---

/** Delete artifact files of terminal records past the retention window.
 *  Records still running, and worktrees holding the only copy of changes,
 *  are never touched. Returns the pruned ids. */
export async function pruneWorkerArtifacts(cwd: string, now = Date.now()): Promise<string[]> {
  const pruned: string[] = [];
  for (const record of await listRecordFiles(cwd)) {
    if (record.status === "running") continue;
    if (record.endedAt === undefined || now - record.endedAt <= WORKER_RETENTION_MS) continue;
    // Retain the record when the worktree cannot be discarded. A missing
    // capture patch makes this checkout the only remaining copy of changes.
    const outcome = await discardWorktree(cwd, record).catch(() => "failed");
    if (
      (outcome === "kept" || outcome === "failed") &&
      record.worktree &&
      existsSync(record.worktree)
    ) {
      continue;
    }
    pruned.push(record.id);
    await unlink(recordPath(cwd, record.id)).catch(() => {});
    await unlink(streamPath(cwd, record.id)).catch(() => {});
    await unlink(stderrLogPath(cwd, record.id)).catch(() => {});
    await unlink(patchPath(cwd, record.id)).catch(() => {});
  }
  return pruned;
}

/** Delete stream files (`.jsonl` spool and `.stderr.log` capture) that no
 *  record claims and whose worker finished more than a day ago; post-mortem
 *  tails stay available for a day. Both suffixes map to the same worker id,
 *  so a running worker keeps both and a terminal record ages both out
 *  together. `protectIds` are spared unconditionally — transcript-owned
 *  running workers whose record file does not exist yet (adoption pending)
 *  would otherwise lose their spool before finalization can read it. */
export async function pruneStreams(
  cwd: string,
  now = Date.now(),
  protectIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const records = new Map((await listRecordFiles(cwd)).map((r) => [r.id, r]));
  let files: string[] = [];
  try {
    files = await readdir(streamsDir(cwd));
  } catch {
    return;
  }
  for (const file of files) {
    const id = file.endsWith(".stderr.log")
      ? file.slice(0, -".stderr.log".length)
      : file.replace(/\.jsonl$/, "");
    if (protectIds.has(id)) continue;
    const record = records.get(id);
    // Running workers keep their stream; known terminal records keep it for a
    // day (post-mortem tails); everything else is an orphan and goes.
    if (record?.status === "running") continue;
    if (record !== undefined) {
      if (record.endedAt === undefined || now - record.endedAt <= 24 * 60 * 60_000) continue;
    }
    await unlink(join(streamsDir(cwd), file)).catch(() => {});
  }
}

// --- Legacy registry migration ---

/** Legacy single-file registry location (pre-session-scope). */
function legacyRegistryPath(cwd: string): string {
  return join(workersDir(cwd), "registry.json");
}

/**
 * One-time migration from the shared project registry to per-worker artifact
 * files. Old records carry no parent pid, so they classify as orphans: their
 * patches stay collectable, their visibility is explicit instead of ambient.
 * Returns true when a registry was migrated (and renamed aside).
 */
export async function migrateLegacyRegistry(cwd: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(legacyRegistryPath(cwd), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as { workers?: Record<string, unknown> };
    const workers = parsed.workers ?? {};
    for (const record of Object.values(workers)) {
      if (!isWorkerRecord(record)) continue;
      await writeRecordFile(cwd, record);
    }
  } catch (error) {
    // A corrupt legacy registry must not block sessions forever: keep it
    // aside for forensics and move on.
    console.error(`[workers] legacy worker registry unreadable: ${(error as Error).message}`);
  }
  await rm(legacyRegistryPath(cwd), { force: true }).catch(() => {});
  return true;
}

// --- Removal ---

/** Supprimer un worker précis (action remove du tool workers) avec ses
 *  artifacts. Refuse un record running. L'existence du fichier d'artifacts
 *  n'est pas exigée : le transcript est l'autorité d'ownership et l'appelant
 *  valide l'ownership — un ghost (entrée transcript, fichier perdu) se
 *  supprime proprement. */
export async function removeWorkerRecord(cwd: string, id: string): Promise<void> {
  const record = await readRecordFile(cwd, id);
  if (record?.status === "running") {
    throw new Error(`Worker ${id} is still running; cancel it before removing.`);
  }
  await unlink(recordPath(cwd, id)).catch(() => {});
  await unlink(streamPath(cwd, id)).catch(() => {});
  await unlink(stderrLogPath(cwd, id)).catch(() => {});
  await unlink(patchPath(cwd, id)).catch(() => {});
}

/** Convenience read for a single worker's artifact record. */
export async function loadWorker(cwd: string, id: string): Promise<WorkerRecord | undefined> {
  return readRecordFile(cwd, id);
}
