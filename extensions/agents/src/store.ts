/**
 * Persistent worker registry at `<cwd>/.pi/workers/registry.json` plus a
 * patches directory. Unlike background-jobs' in-memory registry, worker
 * records survive restarts: a relaunched session can list past workers and
 * collect patches even though the processes themselves are gone.
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir } from "../../../lib/paths.ts";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import type { WorkerRecord, WorkerRegistryFile } from "./types.ts";

// --- Rétention ---

/** Durée de conservation des records terminaux (comptée depuis endedAt) :
 *  registre, streams et patches sont purgés au-delà. Le roll-up de spend de
 *  la status bar est donc un project-lifetime borné à cette fenêtre. */
export const WORKER_RETENTION_MS = 7 * 24 * 60 * 60_000;

// --- Paths ---

export function workersDir(cwd: string): string {
  return projectStateDir(cwd, "workers");
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

/** Delete stream spool files that no running record claims and whose worker
 *  finished more than a day ago; post-mortem tails stay available for a day. */
export async function pruneStreams(cwd: string, now = Date.now()): Promise<void> {
  const workers = await loadWorkers(cwd);
  let files: string[] = [];
  try {
    files = await readdir(streamsDir(cwd));
  } catch {
    return;
  }
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, "");
    const record = workers[id];
    // Running workers keep their stream; known terminal records keep it for a
    // day (post-mortem tails); everything else is an orphan and goes.
    if (record?.status === "running") continue;
    if (record !== undefined) {
      if (record.endedAt === undefined || now - record.endedAt <= 24 * 60 * 60_000) continue;
    }
    await unlink(join(streamsDir(cwd), file)).catch(() => {});
  }
}

function registryPath(cwd: string): string {
  return join(workersDir(cwd), "registry.json");
}

/** Lock croisé des read-modify-write sur le registre : plusieurs sessions Pi
 *  partagent le même fichier projet, la sérialisation en process seul ne
 *  suffit pas (deux sessions qui lisent puis écrivent se recouvrent et
 *  perdent un record). withFileLock n'est pas réentrant : les primitives
 *  déverrouillées ci-dessous ne doivent JAMAIS être appelées dans une
 *  section qui détient déjà ce lock. */
function registryLockPath(cwd: string): string {
  return join(workersDir(cwd), "registry.json.lock");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// --- Ids ---

export function generateWorkerId(): string {
  // 8 random bytes: parallel delegates create ids within the same
  // millisecond, and 2 bytes collide too easily in that window.
  return `w-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

// --- Registry ---

interface RegistrySnapshot {
  workers: Record<string, WorkerRecord>;
  /** Un ou plusieurs records running ont été reconciliés en failed. */
  changed: boolean;
}

/** Lecture + réconciliation SANS lock : réservé aux sections qui détiennent
 *  déjà registryLockPath. La réconciliation est en mémoire uniquement ;
 *  l'appelant décide d'écrire. */
async function loadWorkersUnlocked(cwd: string): Promise<RegistrySnapshot> {
  let raw: string | undefined;
  try {
    raw = await readFile(registryPath(cwd), "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { workers: {}, changed: false };
    }
    throw new Error(`Worker registry ${registryPath(cwd)} is unreadable: ${String(error)}`);
  }
  let parsed: WorkerRegistryFile;
  try {
    parsed = JSON.parse(raw) as WorkerRegistryFile;
  } catch (error) {
    throw new Error(
      `Worker registry ${registryPath(cwd)} is corrupt (invalid JSON): ${String(error)}`,
    );
  }
  const workers = parsed.workers ?? {};
  // Reconcile on read: a record stuck in "running" whose pid is dead means
  // the parent died before the worker finished. Heal it on every read so the
  // registry reflects reality without waiting for a session_start that may
  // never come (workers are one-shot processes and cannot resume).
  let changed = false;
  for (const worker of Object.values(workers)) {
    if (worker.status !== "running" || worker.pid === undefined) continue;
    if (isProcessAlive(worker.pid)) continue;
    worker.status = "failed";
    worker.error = "worker process is gone (session ended before completion)";
    worker.endedAt = Date.now();
    changed = true;
  }
  return { workers, changed };
}

async function writeWorkersUnlocked(
  cwd: string,
  workers: Record<string, WorkerRecord>,
): Promise<void> {
  await writeJsonAtomic(registryPath(cwd), { workers });
}

export async function loadWorkers(cwd: string): Promise<Record<string, WorkerRecord>> {
  return withFileLock(registryLockPath(cwd), async () => {
    const { workers, changed } = await loadWorkersUnlocked(cwd);
    if (changed) await writeWorkersUnlocked(cwd, workers);
    return workers;
  });
}

// Registry writes are serialized per cwd: the initial running-snapshot save
// and the terminal save race when fast children exit mid-bookkeeping, and
// last-writer-wins would let the stale snapshot win. The queue serializes
// inside this process; withFileLock serializes across sessions.
const saveQueues = new Map<string, Promise<void>>();

export function saveWorker(cwd: string, worker: WorkerRecord): Promise<void> {
  const task = (saveQueues.get(cwd) ?? Promise.resolve()).then(() =>
    withFileLock(registryLockPath(cwd), async () => {
      const { workers, changed } = await loadWorkersUnlocked(cwd);
      if (changed) await writeWorkersUnlocked(cwd, workers);
      // The child may finish before the parent's initial running-snapshot lands;
      // never overwrite a terminal record with a stale running one.
      const existing = workers[worker.id];
      if (existing && existing.status !== "running" && worker.status === "running") return;
      workers[worker.id] = worker;
      await writeWorkersUnlocked(cwd, workers);
    }),
  );
  saveQueues.set(
    cwd,
    task.catch(() => {}),
  );
  return task;
}

/**
 * Réserver un slot de worker AVANT le spawn : la limite et l'unicité du nom
 * sont vérifiées et le record running est écrit DANS la section verrouillée,
 * donc deux sessions qui délèguent en même temps ne peuvent pas franchir
 * toutes deux la limite. Le pid du child n'est pas encore connu ; le record
 * complet arrive ensuite via saveWorker (même id).
 */
export async function reserveWorkerSlot(
  cwd: string,
  worker: WorkerRecord,
  maxWorkers: number,
): Promise<void> {
  return withFileLock(registryLockPath(cwd), async () => {
    const { workers, changed } = await loadWorkersUnlocked(cwd);
    if (changed) await writeWorkersUnlocked(cwd, workers);
    const running = Object.values(workers).filter((w) => w.status === "running");
    const duplicate = running.some((w) => w.name === worker.name && w.id !== worker.id);
    if (duplicate) {
      throw new Error(`A running worker named "${worker.name}" already exists.`);
    }
    if (running.length >= maxWorkers) {
      throw new Error(
        `Worker limit reached (${running.length}/${maxWorkers}). Wait for a worker to finish or raise PI_MAX_WORKERS.`,
      );
    }
    workers[worker.id] = worker;
    await writeWorkersUnlocked(cwd, workers);
  });
}

/** Rétention : records terminaux au-delà de WORKER_RETENTION_MS sortis du
 *  registre, stream spool et patch supprimés avec eux. Ne touche jamais un
 *  record running. Retourne les ids prunés. */
export async function pruneWorkerRecords(cwd: string, now = Date.now()): Promise<string[]> {
  return withFileLock(registryLockPath(cwd), async () => {
    const { workers, changed: reconciled } = await loadWorkersUnlocked(cwd);
    const pruned: string[] = [];
    for (const [id, w] of Object.entries(workers)) {
      if (w.status === "running") continue;
      if (w.endedAt === undefined || now - w.endedAt <= WORKER_RETENTION_MS) continue;
      pruned.push(id);
      delete workers[id];
    }
    if (pruned.length > 0 || reconciled) await writeWorkersUnlocked(cwd, workers);
    for (const id of pruned) {
      await unlink(streamPath(cwd, id)).catch(() => {});
      await unlink(join(patchesDir(cwd), `${id}.diff`)).catch(() => {});
    }
    return pruned;
  });
}

/** Supprimer un record précis (action remove du tool workers) avec ses
 *  artifacts. Refuse un record running et un id inconnu. */
export async function removeWorkerRecord(cwd: string, id: string): Promise<void> {
  return withFileLock(registryLockPath(cwd), async () => {
    const { workers, changed } = await loadWorkersUnlocked(cwd);
    const rec = workers[id];
    if (!rec) throw new Error(`Unknown worker ${id}. Use action=list to see workers.`);
    if (rec.status === "running") {
      throw new Error(`Worker ${id} is still running; cancel it before removing.`);
    }
    delete workers[id];
    await writeWorkersUnlocked(cwd, workers);
    await unlink(streamPath(cwd, id)).catch(() => {});
    await unlink(join(patchesDir(cwd), `${id}.diff`)).catch(() => {});
  });
}

export async function loadWorker(cwd: string, id: string): Promise<WorkerRecord | undefined> {
  return (await loadWorkers(cwd))[id];
}
