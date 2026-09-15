/**
 * Persistent worker registry at `<cwd>/.pi/workers/registry.json` plus a
 * patches directory. Unlike background-jobs' in-memory registry, worker
 * records survive restarts: a relaunched session can list past workers and
 * collect patches even though the processes themselves are gone.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir } from "../../../lib/paths.ts";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import type { WorkerRecord, WorkerRegistryFile } from "./types.ts";

// --- Paths ---

export function workersDir(cwd: string): string {
  return projectStateDir(cwd, "workers");
}

export function patchesDir(cwd: string): string {
  return join(workersDir(cwd), "patches");
}

function registryPath(cwd: string): string {
  return join(workersDir(cwd), "registry.json");
}

// --- Ids ---

export function generateWorkerId(): string {
  // 8 random bytes: parallel delegates create ids within the same
  // millisecond, and 2 bytes collide too easily in that window.
  return `w-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

// --- Registry ---

export async function loadWorkers(cwd: string): Promise<Record<string, WorkerRecord>> {
  let workers: Record<string, WorkerRecord> = {};
  try {
    const raw = await readFile(registryPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as WorkerRegistryFile;
    workers = parsed.workers ?? {};
  } catch {
    return {};
  }
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
  if (changed) await writeJsonAtomic(registryPath(cwd), { workers });
  return workers;
}

// Registry writes are serialized per cwd: the initial running-snapshot save
// and the terminal save race when fast children exit mid-bookkeeping, and
// last-writer-wins would let the stale snapshot win.
const saveQueues = new Map<string, Promise<void>>();

export function saveWorker(cwd: string, worker: WorkerRecord): Promise<void> {
  const task = (saveQueues.get(cwd) ?? Promise.resolve()).then(async () => {
    const workers = await loadWorkers(cwd);
    // The child may finish before the parent's initial running-snapshot lands;
    // never overwrite a terminal record with a stale running one.
    const existing = workers[worker.id];
    if (existing && existing.status !== "running" && worker.status === "running") return;
    workers[worker.id] = worker;
    await writeJsonAtomic(registryPath(cwd), { workers });
  });
  saveQueues.set(
    cwd,
    task.catch(() => {}),
  );
  return task;
}

export async function loadWorker(cwd: string, id: string): Promise<WorkerRecord | undefined> {
  return (await loadWorkers(cwd))[id];
}
