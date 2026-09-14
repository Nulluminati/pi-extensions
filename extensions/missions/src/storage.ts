/**
 * File-backed mission storage. One JSON file per mission under
 * `<cwd>/.pi/missions/`, plus an `active.json` pointer for the mission the
 * session is currently working. Writes are atomic (tmp file + rename) so a
 * crash mid-write cannot corrupt a mission.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import type { Mission, MissionSummary, TaskStatus } from "./types.ts";

// --- Constants ---

const MISSIONS_DIR = ".pi/missions";
const ACTIVE_FILE = "active.json";
// The wait deadline must exceed the stale window: a waiter that outlives
// the stale window can observe and reclaim an abandoned lock instead of
// giving up while the holder's final refresh is still in flight.
const LOCK_TIMEOUT_MS = 35_000;
const LOCK_STALE_MS = 30_000;
// How often a held lock's mtime is touched; well under LOCK_STALE_MS so a
// live hold never looks abandoned.
const LOCK_REFRESH_MS = 10_000;
const ALL_TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "regressed",
];

// --- Helpers ---

export function missionsDir(cwd: string): string {
  return join(cwd, MISSIONS_DIR);
}

export function generateMissionId(): string {
  return `mission-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function generateTaskId(): string {
  return `task-${randomBytes(3).toString("hex")}`;
}

export function generateCheckpointId(): string {
  return `ckpt-${randomBytes(3).toString("hex")}`;
}

function missionPath(cwd: string, id: string): string {
  return join(missionsDir(cwd), `${id}.json`);
}

function missionLockPath(cwd: string, id: string): string {
  return join(missionsDir(cwd), ".locks", `${encodeURIComponent(id)}.lock`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export interface LockTimings {
  /** Total time a waiter spends before giving up. Must be >= staleMs. */
  timeoutMs?: number;
  /** Age at which an untouched lock is treated as abandoned. */
  staleMs?: number;
  /** How often the holder touches the lock's mtime while held. */
  refreshMs?: number;
}

/**
 * Acquire the advisory lock file for a mission; returns an async release
 * function. While held, the lock's mtime is refreshed on an interval so a
 * hold longer than the stale window cannot be mistaken for an abandoned
 * lock and stolen by a waiting session. The refresher is cleared on release.
 */
export async function acquireMissionLock(
  cwd: string,
  id: string,
  timings: LockTimings = {},
): Promise<() => Promise<void>> {
  let releaseHold!: () => void;
  const released = new Promise<void>((resolveHold) => {
    releaseHold = resolveHold;
  });
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolveAcquired) => {
    markAcquired = resolveAcquired;
  });
  const finished = withFileLock(
    missionLockPath(cwd, id),
    async () => {
      markAcquired();
      await released;
    },
    {
      staleMs: timings.staleMs ?? LOCK_STALE_MS,
      refreshMs: timings.refreshMs ?? LOCK_REFRESH_MS,
      timeoutMs: timings.timeoutMs ?? LOCK_TIMEOUT_MS,
      timeoutMessage: `Timed out waiting to update mission ${id}; another session is saving it.`,
    },
  );
  // The lock is ours once fn starts running; finished rejects instead when
  // acquisition times out, and that rejection is the caller's error.
  await Promise.race([acquired, finished]);
  return async () => {
    releaseHold();
    await finished;
  };
}

function isActiveMission(value: unknown): value is Mission {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<Mission>;
  return (
    typeof m.id === "string" &&
    typeof m.title === "string" &&
    typeof m.objective === "string" &&
    typeof m.status === "string" &&
    Array.isArray(m.tasks) &&
    Array.isArray(m.checkpoints) &&
    Array.isArray(m.decisions)
  );
}

// --- Active pointer ---

export async function getActiveMissionId(cwd: string): Promise<string | undefined> {
  const path = join(missionsDir(cwd), ACTIVE_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Active mission pointer ${path} is corrupt (invalid JSON): ${detail}`);
  }
  const id = (parsed as { id?: unknown } | null)?.id;
  if (typeof id !== "string") {
    throw new Error(`Active mission pointer ${path} is corrupt (missing mission id).`);
  }
  return id;
}

export async function setActiveMissionId(cwd: string, id: string | undefined): Promise<void> {
  const pointer = join(missionsDir(cwd), ACTIVE_FILE);
  if (id === undefined) {
    await unlink(pointer).catch(() => {});
    return;
  }
  await mkdir(missionsDir(cwd), { recursive: true });
  await writeJsonAtomic(pointer, { id });
}

// --- Mission CRUD ---

export async function saveMission(cwd: string, mission: Mission): Promise<void> {
  await mkdir(missionsDir(cwd), { recursive: true });
  const release = await acquireMissionLock(cwd, mission.id);
  try {
    const stored = await loadMission(cwd, mission.id);
    if (stored && stored.updatedAt !== mission.updatedAt) {
      throw new Error(
        `Mission ${mission.id} changed by another session. Run mission status, then retry your update.`,
      );
    }
    const updatedAt = Math.max(Date.now(), mission.updatedAt + 1);
    await writeJsonAtomic(missionPath(cwd, mission.id), { ...mission, updatedAt });
    mission.updatedAt = updatedAt;
  } finally {
    await release();
  }
}

export async function loadMission(cwd: string, id: string): Promise<Mission | undefined> {
  const path = missionPath(cwd, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Mission file ${path} is corrupt (invalid JSON): ${detail}`);
  }
  if (!isActiveMission(parsed)) {
    throw new Error(`Mission file ${path} is corrupt (does not match the mission shape).`);
  }
  return parsed;
}

/** Load the mission the active pointer references, if it still exists. */
export async function loadActiveMission(cwd: string): Promise<Mission | undefined> {
  const id = await getActiveMissionId(cwd);
  if (!id) return undefined;
  const mission = await loadMission(cwd, id);
  if (!mission) {
    // Dangling pointer (mission file deleted) — clear it.
    await setActiveMissionId(cwd, undefined);
  }
  return mission;
}

export async function listMissionSummaries(cwd: string): Promise<MissionSummary[]> {
  let files: string[] = [];
  try {
    files = await readdir(missionsDir(cwd));
  } catch {
    return [];
  }
  const summaries: MissionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file === ACTIVE_FILE) continue;
    const mission = await loadMission(cwd, file.replace(/\.json$/, ""));
    if (!mission) continue;
    const taskCounts = Object.fromEntries(ALL_TASK_STATUSES.map((s) => [s, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const task of mission.tasks) taskCounts[task.status] += 1;
    summaries.push({
      id: mission.id,
      title: mission.title,
      status: mission.status,
      updatedAt: mission.updatedAt,
      taskCounts,
    });
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}
