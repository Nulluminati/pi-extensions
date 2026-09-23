/**
 * Session-scoped worker state.
 *
 * The owning session's transcript is the source of truth for its workers:
 * every state transition appends a `worker-record` custom entry (restored by
 * `pi -c`/`-r` with the session), so ownership needs no registry. Project
 * disk keeps only per-worker artifact files — `records/<id>.json` (metadata
 * written by the owning session alone, carrying the parent pid so a later
 * session can classify leftovers), the `streams/<id>.jsonl` spool, and
 * `patches/<id>.diff`. No shared mutable registry, no cross-process
 * read-modify-write; the only lock left guards a collect's recordedBy write.
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir } from "../../../lib/paths.ts";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import type { WorkerRecord } from "./types.ts";

// --- Rétention ---

/** Durée de conservation des artifacts des records terminaux (comptée depuis
 *  endedAt) : record.json, stream et patch sont purgés au-delà. Les records
 *  running ne sont jamais prunés. */
export const WORKER_RETENTION_MS = 7 * 24 * 60 * 60_000;

// --- Paths ---

export function workersDir(cwd: string): string {
  return projectStateDir(cwd, "workers");
}

export function recordsDir(cwd: string): string {
  return join(workersDir(cwd), "records");
}

export function recordPath(cwd: string, workerId: string): string {
  return join(recordsDir(cwd), `${workerId}.json`);
}

export function patchesDir(cwd: string): string {
  return join(workersDir(cwd), "patches");
}

/** Per-worker stream projection (filtered event log for the tail action). */
export function streamsDir(cwd: string): string {
  return join(workersDir(cwd), "streams");
}

export function streamPath(cwd: string, workerId: string): string {
  return join(streamsDir(cwd), `${workerId}.jsonl`);
}

/** Stream spool cap: past this, the runner stops appending and records a
 *  truncation marker (the head of the stream is preserved). */
export const STREAM_MAX_BYTES = 512 * 1024;

/** Per-record lock: sérialise le read-modify-write de collect sur le
 *  record.json d'un worker étranger (l'owner n'écrit jamais via ce lock ;
 *  ses writes sont single-writer par construction). */
function recordLockPath(cwd: string, workerId: string): string {
  return join(recordsDir(cwd), `${workerId}.lock`);
}

/** Transcript custom entry type carrying worker records. */
export const WORKER_RECORD_ENTRY = "worker-record";

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
    typeof (value as WorkerRecord).id === "string" &&
    typeof (value as WorkerRecord).status === "string"
  );
}

/**
 * Reconstruct the calling session's workers from its transcript branch.
 * Entries are append-only state transitions; the last entry per worker id
 * wins. Corrupt or foreign entries are ignored.
 */
export function loadWorkersFromBranch(branch: unknown[]): Map<string, WorkerRecord> {
  const workers = new Map<string, WorkerRecord>();
  for (const entry of branch) {
    const candidate = entry as { type?: string; customType?: string; data?: unknown };
    if (candidate?.type !== "custom" || candidate.customType !== WORKER_RECORD_ENTRY) continue;
    if (!isWorkerRecord(candidate.data)) continue;
    workers.set(candidate.data.id, candidate.data);
  }
  return workers;
}

// --- Artifact record files (janitor metadata) ---

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

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
  try {
    const raw = await readFile(recordPath(cwd, workerId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isWorkerRecord(parsed) ? parsed : undefined;
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
    const record = await readRecordFile(cwd, file.replace(/\.json$/, ""));
    if (record) records.push(record);
  }
  return records;
}

// --- Persistence (composition root) ---

/** Persistence queues per cwd: the running-snapshot save and the terminal
 *  save can race inside one process when a child exits mid-bookkeeping;
 *  the queue keeps transcript and artifact file order stable. */
const persistQueues = new Map<string, Promise<unknown>>();

/**
 * Persist one worker state transition: a transcript entry in the owning
 * session (ownership) plus the artifact metadata file (janitor). Returns
 * false when a late running snapshot would clobber a terminal state — the
 * caller must then not adopt it into its in-memory cache either.
 */
export function persistWorkerRecord(
  appendEntry: (customType: string, data: unknown) => void,
  cwd: string,
  worker: WorkerRecord,
): Promise<boolean> {
  const task = (persistQueues.get(cwd) ?? Promise.resolve())
    .then(async () => {
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
      console.error(`[agents] worker record persistence failed: ${(error as Error).message}`);
      throw error;
    });
  persistQueues.set(
    cwd,
    task.catch(() => {}),
  );
  return task;
}

// --- Reconciliation ---

/**
 * Mark the session's own stuck-running records failed when their worker pid
 * is dead (the parent died before the worker finished, or the worker
 * process vanished). Returns the changed records for the caller to persist;
 * records without a pid (spawn never completed) are left for the caller.
 */
export function reconcileRunning(workers: Iterable<WorkerRecord>): WorkerRecord[] {
  const changed: WorkerRecord[] = [];
  for (const worker of workers) {
    if (worker.status !== "running" || worker.pid === undefined) continue;
    if (isProcessAlive(worker.pid)) continue;
    worker.status = "failed";
    worker.error = "worker process is gone (session ended before completion)";
    worker.endedAt = Date.now();
    changed.push(worker);
  }
  return changed;
}

// --- Janitor ---

/** Classification of artifact records left by other sessions. */
export interface ArtifactSweep {
  /** Worker process still alive: running under another live session. */
  foreignLive: WorkerRecord[];
  /** Owning session is gone (or predates ownership): collectable leftovers. */
  orphans: WorkerRecord[];
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
  const sweep: ArtifactSweep = { foreignLive: [], orphans: [] };
  for (const record of await listRecordFiles(cwd)) {
    if (myWorkerIds.has(record.id)) continue;
    if (record.parentPid !== undefined && isProcessAlive(record.parentPid)) {
      sweep.foreignLive.push(record);
    } else {
      sweep.orphans.push(record);
    }
  }
  return sweep;
}

// --- Retention ---

/** Delete artifact files of terminal records past the retention window.
 *  Records still running, and anything whose parent session may still want
 *  it, are never touched. Returns the pruned ids. */
export async function pruneWorkerArtifacts(cwd: string, now = Date.now()): Promise<string[]> {
  const pruned: string[] = [];
  for (const record of await listRecordFiles(cwd)) {
    if (record.status === "running") continue;
    if (record.endedAt === undefined || now - record.endedAt <= WORKER_RETENTION_MS) continue;
    pruned.push(record.id);
  }
  for (const id of pruned) {
    await unlink(recordPath(cwd, id)).catch(() => {});
    await unlink(streamPath(cwd, id)).catch(() => {});
    await unlink(join(patchesDir(cwd), `${id}.diff`)).catch(() => {});
  }
  return pruned;
}

/** Delete stream spool files that no record file claims and whose worker
 *  finished more than a day ago; post-mortem tails stay available for a day. */
export async function pruneStreams(cwd: string, now = Date.now()): Promise<void> {
  const records = new Map((await listRecordFiles(cwd)).map((r) => [r.id, r]));
  let files: string[] = [];
  try {
    files = await readdir(streamsDir(cwd));
  } catch {
    return;
  }
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, "");
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
    console.error(`[agents] legacy worker registry unreadable: ${(error as Error).message}`);
  }
  await rm(legacyRegistryPath(cwd), { force: true }).catch(() => {});
  return true;
}

// --- Removal ---

/** Supprimer un worker précis (action remove du tool workers) avec ses
 *  artifacts. Refuse un record running et un id inconnu. */
export async function removeWorkerRecord(cwd: string, id: string): Promise<void> {
  const record = await readRecordFile(cwd, id);
  if (!record) throw new Error(`Unknown worker ${id}. Use action=list to see workers.`);
  if (record.status === "running") {
    throw new Error(`Worker ${id} is still running; cancel it before removing.`);
  }
  await unlink(recordPath(cwd, id)).catch(() => {});
  await unlink(streamPath(cwd, id)).catch(() => {});
  await unlink(join(patchesDir(cwd), `${id}.diff`)).catch(() => {});
}

/** Convenience read for a single worker's artifact record. */
export async function loadWorker(cwd: string, id: string): Promise<WorkerRecord | undefined> {
  return readRecordFile(cwd, id);
}
