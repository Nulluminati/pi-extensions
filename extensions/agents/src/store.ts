/**
 * Persistent worker registry at `<cwd>/.pi/workers/registry.json` plus a
 * patches directory. Unlike background-jobs' in-memory registry, worker
 * records survive restarts: a relaunched session can list past workers and
 * collect patches even though the processes themselves are gone.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  try {
    const raw = await readFile(registryPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as WorkerRegistryFile;
    return parsed.workers ?? {};
  } catch {
    return {};
  }
}

export async function saveWorker(cwd: string, worker: WorkerRecord): Promise<void> {
  const workers = await loadWorkers(cwd);
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
