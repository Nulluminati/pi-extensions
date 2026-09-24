/**
 * File-backed mission storage. One JSON file per mission under
 * `<cwd>/.pi/missions/`. Which mission a session is working is session
 * state (persisted in the session transcript, not on disk). Writes are atomic (tmp file + rename) so a
 * crash mid-write cannot corrupt a mission.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { withFileLock } from "../../../lib/file-lock.ts";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import { projectStateDir } from "../../../lib/paths.ts";
import type { Mission, MissionListResult, MissionSummary, TaskStatus } from "./types.ts";

// --- Constants ---

// The wait deadline must exceed the stale window: a waiter that outlives
// the stale window can observe and reclaim an abandoned lock instead of
// giving up while the holder's final refresh is still in flight.
const LOCK_TIMEOUT_MS = 35_000;
const LOCK_STALE_MS = 30_000;
// How often a held lock's mtime is touched; well under LOCK_STALE_MS so a
// live hold never looks abandoned.
const LOCK_REFRESH_MS = 10_000;
// Ids come from tool calls and are joined into filesystem paths, so their
// formats are anchored exactly to what the generators produce. Anything else
// is rejected before it can reach a path.
const MISSION_ID_PATTERN = /^mission-[0-9a-z]+-[0-9a-f]{16}$/;
const TASK_ID_PATTERN = /^task-[0-9a-f]{6}$/;
const CHECKPOINT_ID_PATTERN = /^ckpt-[0-9a-f]{6}$/;
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
  return projectStateDir(cwd, "missions");
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

// --- Id validation ---

export function isMissionId(id: string): boolean {
  return MISSION_ID_PATTERN.test(id);
}

export function isTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

export function isCheckpointId(id: string): boolean {
  return CHECKPOINT_ID_PATTERN.test(id);
}

/** Validate an id received from a tool call (or stored pointer) against the
 *  generated format; returns the id or throws. */
export function validateMissionId(id: string): string {
  if (!isMissionId(id)) throw new Error(`Invalid mission id: ${id}`);
  return id;
}

export function validateTaskId(id: string): string {
  if (!isTaskId(id)) throw new Error(`Invalid task id: ${id}`);
  return id;
}

export function validateCheckpointId(id: string): string {
  if (!isCheckpointId(id)) throw new Error(`Invalid checkpoint id: ${id}`);
  return id;
}

/** Defense-in-depth path containment: verify a candidate path resolves
 *  inside this project's missions directory before it is used for reads or
 *  writes. Id validation already excludes path separators, so a violation
 *  means a bug — refuse loudly rather than touch the file. */
export function ensureInsideMissionsDir(cwd: string, candidate: string): string {
  const dir = resolve(missionsDir(cwd));
  const resolved = resolve(candidate);
  if (!resolved.startsWith(`${dir}${sep}`)) {
    throw new Error(`Mission path escapes the missions directory: ${candidate}`);
  }
  return resolved;
}

function missionPath(cwd: string, id: string): string {
  return ensureInsideMissionsDir(cwd, join(missionsDir(cwd), `${validateMissionId(id)}.json`));
}

function missionLockPath(cwd: string, id: string): string {
  return ensureInsideMissionsDir(
    cwd,
    join(missionsDir(cwd), ".locks", `${encodeURIComponent(validateMissionId(id))}.lock`),
  );
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

// --- Mission CRUD ---

export async function saveMission(cwd: string, mission: Mission): Promise<void> {
  validateMissionId(mission.id);
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
  validateMissionId(id);
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
  // A record on disk may carry an id it was not stored under (older file or
  // tampered content). Operating on it would re-save it wherever its id
  // points, so refuse instead.
  if (parsed.id !== id) {
    throw new Error(
      `Mission file ${path} is corrupt: stored id "${parsed.id}" does not match the requested id "${id}".`,
    );
  }
  return parsed;
}

export async function listMissionSummaries(cwd: string): Promise<MissionListResult> {
  let files: string[] = [];
  try {
    files = await readdir(missionsDir(cwd));
  } catch {
    return { summaries: [], skipped: [] };
  }
  const summaries: MissionSummary[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const stem = file.replace(/\.json$/, "");
    // Stray files that do not carry a valid mission id are skipped: a
    // listing must not crash on hand-created or foreign files.
    if (!isMissionId(stem)) continue;
    // A corrupt file (invalid JSON, wrong shape, or mismatched stored id)
    // must not fail the whole listing either: skip it and report it so the
    // user can find and repair the file.
    let mission: Mission | undefined;
    try {
      mission = await loadMission(cwd, stem);
    } catch {
      skipped.push(file);
      continue;
    }
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
  return { summaries: summaries.sort((a, b) => b.updatedAt - a.updatedAt), skipped };
}
