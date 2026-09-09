/**
 * Persistent worker registry at `<cwd>/.pi/workers/registry.json` plus a
 * patches directory. Unlike background-jobs' in-memory registry, worker
 * records survive restarts: a relaunched session can list past workers and
 * collect patches even though the processes themselves are gone.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import type { WorkerRecord, WorkerRegistryFile } from "./types.ts";

// --- Paths ---

export function workersDir(cwd: string): string {
  return join(cwd, ".pi", "workers");
}

export function patchesDir(cwd: string): string {
  return join(workersDir(cwd), "patches");
}

function registryPath(cwd: string): string {
  return join(workersDir(cwd), "registry.json");
}

// --- Ids ---

export function generateWorkerId(): string {
  return `w-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

// --- Registry ---

async function writeAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

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
  if (changed) await writeAtomic(registryPath(cwd), { workers });
  return workers;
}

export async function saveWorker(cwd: string, worker: WorkerRecord): Promise<void> {
  const workers = await loadWorkers(cwd);
  // The child may finish before the parent's initial running-snapshot lands;
  // never overwrite a terminal record with a stale running one.
  const existing = workers[worker.id];
  if (existing && existing.status !== "running" && worker.status === "running") return;
  workers[worker.id] = worker;
  await writeAtomic(registryPath(cwd), { workers });
}

export async function loadWorker(cwd: string, id: string): Promise<WorkerRecord | undefined> {
  return (await loadWorkers(cwd))[id];
}

export function listRunning(workers: Record<string, WorkerRecord>): WorkerRecord[] {
  return Object.values(workers)
    .filter((w) => w.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
}
