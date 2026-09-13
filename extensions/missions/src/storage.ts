/**
 * File-backed mission storage. One JSON file per mission under
 * `<cwd>/.pi/missions/`, plus an `active.json` pointer for the mission the
 * session is currently working. Writes are atomic (tmp file + rename) so a
 * crash mid-write cannot corrupt a mission.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mission, MissionSummary, TaskStatus } from "./types.ts";

// --- Constants ---

const MISSIONS_DIR = ".pi/missions";
const ACTIVE_FILE = "active.json";
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
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
  return `mission-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
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

async function acquireMissionLock(cwd: string, id: string): Promise<() => Promise<void>> {
  const path = missionLockPath(cwd, id);
  await mkdir(join(missionsDir(cwd), ".locks"), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(path).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update mission ${id}; another session is saving it.`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
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

/** Atomic JSON write: write to a temp sibling, then rename over the target. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

// --- Active pointer ---

export async function getActiveMissionId(cwd: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(missionsDir(cwd), ACTIVE_FILE), "utf8");
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
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
  const raw = await readFile(missionPath(cwd, id), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isActiveMission(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
