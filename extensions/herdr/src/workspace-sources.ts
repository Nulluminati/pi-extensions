/** Discovery records describe live Pi contributors, never worker state or output. */

import { isAbsolute } from "node:path";
import { isProcessAlive, type ShardRecord } from "../../../lib/presence-shards.ts";
import { isRecycledPid } from "../../../lib/process-identity.ts";
import { isWorkerId } from "../../workers/src/ids.ts";

export const SOURCE_TTL_MS = 60_000;

export interface MonitorSource extends ShardRecord {
  cwd: string;
  workerIds: string[];
  updatedAt: number;
}

export function isMonitorSource(value: unknown): value is MonitorSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.name === "string" &&
    source.name.length > 0 &&
    typeof source.pid === "number" &&
    Number.isSafeInteger(source.pid) &&
    source.pid > 0 &&
    typeof source.cwd === "string" &&
    isAbsolute(source.cwd) &&
    typeof source.updatedAt === "number" &&
    Number.isFinite(source.updatedAt) &&
    (source.processStartedAt === undefined || typeof source.processStartedAt === "string") &&
    Array.isArray(source.workerIds) &&
    source.workerIds.every(isWorkerId)
  );
}

export async function sourceIsLive(source: MonitorSource): Promise<boolean> {
  const age = Date.now() - source.updatedAt;
  return (
    age >= -SOURCE_TTL_MS &&
    age < SOURCE_TTL_MS &&
    isProcessAlive(source.pid) &&
    !(await isRecycledPid(source.pid, source.processStartedAt))
  );
}
