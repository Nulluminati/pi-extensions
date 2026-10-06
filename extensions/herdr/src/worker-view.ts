/** Bounded, read-only worker artifact snapshots. Worker output is terminal data only. */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isNodeError } from "../../../lib/errors.ts";
import { formatRawStreamEntries, formatStreamEntries } from "../../workers/src/format.ts";
import { assertWorkerId, isWorkerId } from "../../workers/src/ids.ts";
import { recordPath, stderrLogPath, streamPath } from "../../workers/src/store.ts";
import { isMonitorSource, sourceIsLive } from "./workspace-sources.ts";

const RECORD_BYTES = 256 * 1024;
const STREAM_BYTES = 64 * 1024;
const STDERR_BYTES = 4 * 1024;
const LINE_CHARS = 240;
const STATUSES = new Set(["running", "completed", "failed", "timeout", "cancelled"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(text: string): string {
  // Output cannot issue terminal commands or change the displayed text direction.
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, LINE_CHARS);
}

function textLines(value: unknown, limit: number): string[] {
  return typeof value === "string"
    ? value.split("\n").slice(-limit).map(clean).filter(Boolean)
    : [];
}

async function readBounded(
  path: string,
  bytes: number,
  tail = false,
  strict = false,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Do not block on FIFOs or follow artifact symlinks into unrelated files.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const { size } = stat;
    if (!stat.isFile() || (!tail && size > bytes)) {
      if (strict) throw new Error("Worker monitor list unavailable");
      return undefined;
    }
    const start = tail ? Math.max(0, size - bytes) : 0;
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return object(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkerReference {
  cwd: string;
  id: string;
}

export interface WorkerSnapshot extends WorkerReference {
  name: string;
  status: string;
  model?: string;
  error?: string;
  activity: string[];
  report: string[];
  stderr: string[];
}

export async function readWorkerReferences(cwd: string, path: string): Promise<WorkerReference[]> {
  const text = await readBounded(path, 64 * 1024, false, true);
  if (text === undefined) return [];
  const list = parseObject(text);
  if (list?.sources === undefined) {
    const ids = list?.workerIds;
    if (!Array.isArray(ids) || !ids.every(isWorkerId))
      throw new Error("Invalid worker monitor list");
    return [...new Set(ids)].map((id) => ({ cwd, id }));
  }
  if (!Array.isArray(list.sources) || !list.sources.every(isMonitorSource))
    throw new Error("Invalid worker monitor list");
  const refs = new Map<string, WorkerReference>();
  for (const source of list.sources) {
    if (!(await sourceIsLive(source))) continue;
    for (const id of source.workerIds)
      refs.set(`${source.cwd}\u0000${id}`, { cwd: source.cwd, id });
  }
  return [...refs.values()];
}

export async function readWorkspaceWorkersView(
  refs: readonly WorkerReference[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const ref of refs) {
    lines.push(clean(`Project: ${ref.cwd}`), ...(await readWorkersView(ref.cwd, [ref.id])));
  }
  return lines;
}

export async function readWorkerIds(path: string): Promise<string[]> {
  const text = await readBounded(path, 64 * 1024, false, true);
  if (text === undefined) return [];
  const ids = parseObject(text)?.workerIds;
  if (!Array.isArray(ids) || !ids.every(isWorkerId)) throw new Error("Invalid worker monitor list");
  return [...new Set(ids)];
}

export async function readWorkersView(cwd: string, ids: readonly string[]): Promise<string[]> {
  for (const id of ids) assertWorkerId(id);
  const lines: string[] = [];
  for (const id of ids) {
    const worker = await readWorkerView(cwd, id);
    lines.push(...worker.slice(0, 2));
    const error = worker.find((line) => line.startsWith("Error:"));
    if (error) lines.push(error);
    for (const [heading, count, prefix] of [
      ["Recent activity:", 2, ""],
      ["Report:", 2, "Report: "],
      ["Stderr:", 1, "Stderr: "],
    ] as const) {
      const start = worker.indexOf(heading) + 1;
      if (start === 0) continue;
      const section: string[] = [];
      for (const line of worker.slice(start)) {
        if (!line) break;
        section.push(line);
      }
      const selected =
        heading === "Recent activity:" ? section.slice(-count) : section.slice(0, count);
      lines.push(...selected.map((line) => clean(`${prefix}${line}`)));
    }
    lines.push("");
  }
  return lines;
}

function workerRecord(text: string | undefined, id: string): Record<string, unknown> | undefined {
  const parsed = text === undefined ? undefined : parseObject(text);
  return parsed?.id === id && typeof parsed.status === "string" && STATUSES.has(parsed.status)
    ? parsed
    : undefined;
}

export async function readWorkerRecord(
  cwd: string,
  id: string,
  maxBytes = RECORD_BYTES,
): Promise<Record<string, unknown> | undefined> {
  assertWorkerId(id);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
    throw new Error("Invalid worker record read limit");
  return workerRecord(await readBounded(recordPath(cwd, id), maxBytes), id);
}

export async function readWorkerSnapshot(cwd: string, id: string): Promise<WorkerSnapshot> {
  assertWorkerId(id);
  const [recordText, stream, stderr] = await Promise.all([
    readBounded(recordPath(cwd, id), RECORD_BYTES),
    readBounded(streamPath(cwd, id), STREAM_BYTES, true),
    readBounded(stderrLogPath(cwd, id), STDERR_BYTES, true),
  ]);
  const record = workerRecord(recordText, id);
  const name = typeof record?.name === "string" ? record.name : id;
  const events = (stream ?? "").split("\n").filter((line) => parseObject(line) !== undefined);
  const activity =
    record?.streamFormat === "raw" || record === undefined
      ? formatRawStreamEntries(events)
      : formatStreamEntries(events.join("\n"));
  return {
    cwd: clean(cwd),
    id,
    name: clean(name),
    status: record ? String(record.status) : "unavailable",
    ...(typeof record?.model === "string" ? { model: clean(record.model) } : {}),
    ...(typeof record?.error === "string" ? { error: clean(record.error) } : {}),
    activity: activity.slice(-24).map(clean),
    report: textLines(record?.outputText, 12),
    stderr: textLines(stderr, 8),
  };
}

export async function readWorkerView(cwd: string, id: string): Promise<string[]> {
  const worker = await readWorkerSnapshot(cwd, id);
  const lines = [
    `Worker ${worker.name} (${id})`,
    worker.status === "unavailable" ? "Worker record unavailable" : `Status: ${worker.status}`,
  ];
  if (worker.model !== undefined) lines.push(`Model: ${worker.model}`);
  if (worker.error !== undefined) lines.push(`Error: ${worker.error}`);
  lines.push("", "Recent activity:", ...worker.activity);
  if (worker.report.length > 0) lines.push("", "Report:", ...worker.report);
  if (worker.stderr.length > 0) lines.push("", "Stderr:", ...worker.stderr);
  lines.push("", "Read-only monitor. Closing this pane does not stop the worker.");
  return lines.map(clean);
}
