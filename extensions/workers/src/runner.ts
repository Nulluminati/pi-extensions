/**
 * Worker runner: spawns a child `pi --mode json --no-session -p <task>`
 * process in its own process group and enforces a hard timeout.
 *
 * The child's stdout and stderr are files in the worker directory, not pipes
 * to the parent: the child writes its own JSON event stream to the spool
 * (`streams/<id>.jsonl`) and its stderr to `streams/<id>.stderr.log`, so
 * output survives the parent's death and any session can read it. The
 * spawning parent tails the spool for live activity; finalization (status
 * inference, patch capture, terminal persistence, wake) is a shared
 * disk-based operation (`finalizeWorker`) that the parent, an adopting
 * session, or a janitor sweep can all perform — idempotently.
 *
 * Wake-ups are trusted messages (ids and status words only); worker output
 * lives in the spool and is read via the workers tool.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "pi";
import { cleanGitEnv } from "../../../lib/git.ts";
import { projectStateRelative } from "../../../lib/paths.ts";
import { isProcessAlive } from "../../../lib/presence-shards.ts";
import {
  BLOCKER_MARKER_TYPE,
  parseBlockerMarker,
  WORKER_STREAM_ENV_VAR,
} from "../../../lib/worker-blocker.ts";
import { abortReason, SetupHookCancelled } from "./provision/hook.ts";
import type { ProvisionStatus } from "./provision/types.ts";
import { stderrLogPath, streamPath, patchPath as workerPatchPath } from "./store.ts";
import type { WorkerActivity, WorkerEvents, WorkerRecord } from "./types.ts";
import { captureWorktreePatch } from "./worktree.ts";

// --- Constants ---

export const CANCEL_GRACE_MS = 4_000;
/** Arg/result summaries in stream displays stay one line and short. */
export const STREAM_SUMMARY_CHARS = 200;
/** How often the parent tails the spool for live activity. */
const INGEST_POLL_MS = 400;
const STDERR_TAIL_BYTES = 4 * 1024;
/** Tail reads are bounded: the tail display and finalization never load
 *  more than this much of a spool, however much the child wrote. */
export const STREAM_TAIL_BYTES = 512 * 1024;

/** Parent-appended markers in the raw spool (distinguishable from pi JSON
 *  events, which never use the `workers_` type prefix). */
interface AgentSpoolMarker {
  type: "workers_start" | "workers_end";
  at: number;
  task?: string;
  status?: WorkerRecord["status"];
  error?: string;
}

// --- Stream summaries ---

/** One-line summary of tool args or results: prefer the common location /
 *  command keys, fall back to a truncated JSON dump. Never multi-line. */
export function summarizeStreamValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const preferred =
    typeof value === "object" && value !== null
      ? ((value as Record<string, unknown>).path ??
        (value as Record<string, unknown>).file_path ??
        (value as Record<string, unknown>).command ??
        (value as Record<string, unknown>).pattern ??
        (value as Record<string, unknown>).url ??
        (value as Record<string, unknown>).query ??
        (value as Record<string, unknown>).task)
      : value;
  if (typeof preferred === "string" && !preferred.trim()) return undefined;
  const raw = typeof preferred === "string" && preferred.trim() ? preferred : JSON.stringify(value);
  const oneLine = raw.replace(/\\?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > STREAM_SUMMARY_CHARS
    ? `${oneLine.slice(0, STREAM_SUMMARY_CHARS)}…`
    : oneLine;
}

// --- Spool IO ---

async function appendSpoolLine(cwd: string, workerId: string, event: AgentSpoolMarker) {
  await mkdir(join(streamPath(cwd, workerId), ".."), { recursive: true }).catch(() => {});
  await appendFile(streamPath(cwd, workerId), `${JSON.stringify(event)}\n`, "utf8").catch(() => {});
}

/** Last `bytes` of a file, split into complete lines (a trailing partial
 *  line without a newline is still returned). A first line cut by the
 *  window boundary is dropped, not parsed; `truncated` reports whether
 *  the window cut earlier bytes off the file, so a caller can tell an
 *  absent event from an unreadable one. */
async function readTailLines(
  path: string,
  bytes: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return { lines: [], truncated: false };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // Drop the trailing empty piece from a final newline; keep a partial
    // last line (no trailing newline) as a line of its own.
    if (lines[lines.length - 1] === "") lines.pop();
    // Drop a possibly-partial first line unless it is the file's first.
    if (start > 0 && lines.length > 0) lines.shift();
    return { lines, truncated: start > 0 };
  } finally {
    await handle.close().catch(() => {});
  }
}

// --- Ingestion (live activity + usage) ---

/**
 * Ingest one raw pi JSON event line from the spool: track live activity on
 * the record (last tool + running tool count) and roll up token/cost usage.
 * The final assistant text is NOT tracked here — it is extracted from the
 * spool at finalization, so it works identically for adopted workers whose
 * parent never saw the output.
 */
export function ingestStreamEvent(jsonLine: string, record: WorkerRecord): "blocker" | undefined {
  let event: {
    type?: string;
    message?: { role?: string; usage?: unknown };
    toolName?: string;
    args?: unknown;
  };
  try {
    event = JSON.parse(jsonLine);
  } catch {
    return undefined;
  }

  // Blocker marker from the worker's report_blocker tool: recorded on the
  // live record; the caller wakes the parent (once). The reason stays here
  // — the wake carries ids and status words only.
  if (event.type === BLOCKER_MARKER_TYPE) {
    const blocker = parseBlockerMarker(jsonLine);
    if (blocker === undefined) return undefined;
    record.blocker = blocker; // last report wins
    return "blocker";
  }

  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    const detail = summarizeStreamValue(event.args);
    const activity: WorkerActivity = {
      tool: event.toolName,
      ...(detail !== undefined ? { detail } : {}),
      toolCount: (record.activity?.toolCount ?? 0) + 1,
      at: Date.now(),
    };
    record.activity = activity;
    return;
  }

  if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
  if (
    event.message.usage !== undefined &&
    typeof event.message.usage === "object" &&
    event.message.usage !== null
  ) {
    const u = event.message.usage as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      totalTokens?: unknown;
      cost?: { total?: unknown };
    };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    let usage = record.usage;
    if (usage === undefined) {
      usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      record.usage = usage;
    }
    usage.inputTokens += num(u.input);
    usage.outputTokens += num(u.output);
    usage.cacheReadTokens += num(u.cacheRead);
    usage.cacheWriteTokens += num(u.cacheWrite);
    usage.costUsd += num(u.cost?.total);
  }
}

// --- Parsing ---

/** Concatenated text-block text from an assistant message's content; empty
 *  when the content is not an array of text blocks. */
export function assistantTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

/**
 * Extract the last assistant text from a pi JSON event stream. Each line is
 * a JSON event; we keep the text of the most recent assistant message_end so
 * the final response wins.
 */
export function extractAssistantText(jsonLine: string, current: string): string {
  try {
    const event = JSON.parse(jsonLine) as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (event.type !== "message_end" || event.message?.role !== "assistant") return current;
    const text = assistantTextFromContent(event.message.content);
    return text || current;
  } catch {
    return current;
  }
}

/** Final assistant text from a raw (child-written) spool. */
function extractFinalTextRaw(lines: string[]): string {
  let text = "";
  for (const line of lines) text = extractAssistantText(line, text);
  return text;
}

/** Final assistant text from a legacy parent-projected spool. */
function extractFinalTextProjected(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { kind?: string; text?: unknown };
      if (event.kind === "assistant" && typeof event.text === "string") text = event.text;
    } catch {}
  }
  return text;
}

function extractFinalText(lines: string[], format: WorkerRecord["streamFormat"]): string {
  return format === "raw" ? extractFinalTextRaw(lines) : extractFinalTextProjected(lines);
}

/** Terminal status recorded in the spool's end marker, when present. */
function spoolEndStatus(lines: string[]): { status?: string; error?: string } {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      const event = JSON.parse(line) as AgentSpoolMarker;
      if (event.type === "workers_end") {
        return {
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        };
      }
    } catch {}
  }
  return {};
}

/** Read only the end of stderr so a noisy worker cannot exhaust memory
 *  during finalization. Keep the last error text, not the start of the tail. */
async function readStderrTail(cwd: string, workerId: string): Promise<string> {
  const handle = await open(stderrLogPath(cwd, workerId), "r").catch(() => undefined);
  if (handle === undefined) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, STDERR_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const tail = buffer.subarray(0, bytesRead).toString("utf8").trim().slice(-STREAM_SUMMARY_CHARS);
    return summarizeStreamValue(tail) ?? tail;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Read the last `bytes` of a worker's spool as complete lines. Used by
 *  the tail action so display never loads an unbounded file. */
export async function readSpoolLines(
  cwd: string,
  workerId: string,
  bytes = STREAM_TAIL_BYTES,
): Promise<string[]> {
  return (await readTailLines(streamPath(cwd, workerId), bytes)).lines;
}

// --- Finalization (shared by parent, adopter, janitor) ---

export interface FinalizeOptions {
  cwd: string;
  record: WorkerRecord;
  /** Status decided by the killer/timeout path; otherwise inferred. */
  statusOverride?: WorkerRecord["status"];
  /** Error detail for an overridden status (e.g. the timeout duration). */
  errorOverride?: string;
  /** Exit code, when the finalizer is the spawning parent. */
  exitCode?: number | null;
  /** Isolated worktree; patch captured for completed/timeout outcomes. */
  worktree?: { path: string; branch: string };
  events?: WorkerEvents;
  /** Terminal persistence (transcript entry + record file for the owner;
   *  record file only for non-owners). */
  onRecord?(record: WorkerRecord): Promise<unknown>;
}

/**
 * Terminalize a worker from its on-disk artifacts. Idempotent: a record
 * already terminal is returned untouched. Status inference: an explicit
 * override (cancel/timeout) wins; an end marker in the spool is honored;
 * otherwise a final assistant report means completed and its absence means
 * failed (with the stderr tail as the error detail). The spool is read as
 * a bounded tail, so absence is only trusted for a spool that fits the
 * window: a truncated spool without a readable report fails with explicit
 * truncation detail, since the report may live in the cut bytes.
 */
export async function finalizeWorker(options: FinalizeOptions): Promise<WorkerRecord> {
  const { cwd, record, statusOverride, errorOverride, exitCode, events, onRecord } = options;
  if (record.status !== "running") return record;
  // Patch capture location: an explicit worktree (spawning parent) or the
  // record's own worktree reference (adoption/janitor finalization).
  const worktree =
    options.worktree ??
    (record.worktree !== undefined
      ? { path: record.worktree, branch: record.branch ?? "" }
      : undefined);

  const spool = await readTailLines(streamPath(cwd, record.id), STREAM_TAIL_BYTES);
  const lines = spool.lines;
  const outputText = extractFinalText(lines, record.streamFormat);
  const endMark = spoolEndStatus(lines);

  // A blocker reported while nobody was watching (adoption, janitor sweep)
  // lives in the spool tail; recover it so the terminal record keeps the why.
  for (const line of lines) {
    const blocker = parseBlockerMarker(line);
    if (blocker !== undefined) record.blocker = blocker;
  }

  let status: WorkerRecord["status"];
  let error: string | undefined;
  if (statusOverride !== undefined) {
    status = statusOverride;
    error = errorOverride ?? (statusOverride === "cancelled" ? "cancelled by user" : undefined);
  } else if (endMark.status !== undefined) {
    status = endMark.status as WorkerRecord["status"];
    error = endMark.error;
  } else if (outputText !== "") {
    status = "completed";
  } else {
    status = "failed";
    const stderrTail = await readStderrTail(cwd, record.id);
    if (spool.truncated) {
      // The window cut bytes away, so an unreadable report cannot be
      // distinguished from a missing one: name the truncation instead of
      // claiming the worker never reported.
      error = `no report in the retained tail; the spool exceeds the finalization read window (${STREAM_TAIL_BYTES} bytes) and earlier output was truncated`;
      if (stderrTail) error += `; stderr: ${stderrTail}`;
    } else {
      error = stderrTail || "worker exited without producing a report";
    }
  }

  record.status = status;
  record.endedAt = Date.now();
  if (exitCode !== undefined) record.exitCode = exitCode;
  if (outputText !== "") record.outputText = outputText;
  else delete record.outputText;
  if (error !== undefined) record.error = error;
  else delete record.error;

  if (worktree !== undefined && (status === "completed" || status === "timeout")) {
    const patchPath = workerPatchPath(cwd, record.id);
    try {
      await captureWorktreePatch(worktree.path, patchPath);
      record.patchPath = patchPath;
    } catch (err) {
      // Capture refuses before storing a patch. Point the record at the
      // absent patch path so collect and retention treat the worktree as
      // the only remaining copy of the worker's changes and keep it for
      // recovery. Keep an earlier terminal error (e.g. the timeout reason)
      // and append the patch failure instead of overwriting it.
      record.patchPath = patchPath;
      const patchError = `patch capture failed: ${(err as Error).message}`;
      record.error = record.error !== undefined ? `${record.error}; ${patchError}` : patchError;
    }
  }

  await appendSpoolLine(cwd, record.id, {
    type: "workers_end",
    at: record.endedAt,
    status,
    ...((error !== undefined && summarizeStreamValue(error) !== undefined
      ? { error: summarizeStreamValue(error) }
      : {}) as Partial<AgentSpoolMarker>),
  });

  if (onRecord) {
    try {
      await onRecord(record);
    } catch (err) {
      console.error(`[workers] terminal record persistence failed: ${(err as Error).message}`);
      events?.notify(
        "error",
        `worker ${record.name} (${record.id}) finished but its record could not be persisted: ${(err as Error).message}`,
      );
    }
  }

  if (events) {
    if (status === "completed") {
      events.wake(
        `[worker ${record.name} (${record.id}) finished]. Use the workers tool (action=status, id=${record.id}) to read its report${record.patchPath ? " and (action=collect) to apply its patch" : ""}.`,
      );
    } else if (status === "failed") {
      events.notify(
        "error",
        `worker ${record.name} (${record.id}) failed: ${error ?? "unknown error"}`,
      );
      events.wake(
        `[worker ${record.name} (${record.id}) failed]. Use the workers tool (action=status, id=${record.id}) for details.`,
      );
    } else if (status === "timeout") {
      events.notify("warning", `worker ${record.name} (${record.id}) timed out`);
      events.wake(
        `[worker ${record.name} (${record.id}) timed out]. Use the workers tool (action=status, id=${record.id}) for details.`,
      );
    }
  }
  return record;
}

// --- Process-group kill (works with or without a ChildProcess handle) ---

/** Kill a worker's whole process group, escalating to SIGKILL. Does not
 *  wait for an exit event: callers poll liveness or rely on close.
 *  Non-positive or non-integer pids are refused: kill(-pid) on pid <= 0
 *  degenerates to a broadcast (kill(-1)) or an unintended target. */
export async function killPidTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // Already gone.
    }
  }
  const deadline = Date.now() + CANCEL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between check and kill; nothing to do.
    }
  }
}

// --- Adopted deadline ---

/** Hard-timeout detail for a record carrying a persisted deadline: the
 *  spawning parent's exact message, recovered from the record's own
 *  startedAt/deadlineAt pair so adoption renders the same cause. */
function adoptedTimeoutDetail(record: WorkerRecord): string {
  const timeoutMs = Math.max(0, (record.deadlineAt ?? record.startedAt) - record.startedAt);
  return `worker exceeded ${Math.round(timeoutMs / 1000)}s timeout`;
}

export interface AdoptedTimeoutOptions {
  cwd: string;
  /** Terminal persistence for the adopted worker (transcript entry + record
   *  file for owned workers; record file only for orphans). */
  onRecord?(record: WorkerRecord): Promise<unknown>;
  /** Wake/notify channel, when the adopter owns the worker. */
  events?: WorkerEvents;
  /** Called synchronously when the deadline fires, before any signal is
   *  sent: the adopter stops its exit poller so the natural-death path
   *  (completed/failed inferred from the spool) cannot win the race against
   *  the timeout terminal save. */
  beforeKill?(): void;
  /** Called after the deadline terminal save settles: the adopter refreshes
   *  its widget and status line. */
  onSettled?(): void;
}

/**
 * Arm an adopted worker's persisted hard timeout — the durable counterpart
 * of the spawning parent's in-memory timer. A record without a deadline
 * (created before deadlines were persisted) is never retroactively timed
 * out: the disposer is a no-op. Otherwise the remaining time — not the
 * original full timeout — is armed; when it elapses the worker's process
 * group is killed and the record is terminalized as "timeout" with the
 * same detail the parent would have written. Returns a disposer clearing
 * the armed timer; a timer that already fired cannot be recalled, but
 * finalizeWorker refuses a record that the adopter's own exit watcher has
 * already terminalized.
 */
export function armAdoptedTimeout(
  record: WorkerRecord,
  options: AdoptedTimeoutOptions,
): () => void {
  if (record.deadlineAt === undefined) return () => {};
  const remaining = Math.max(0, record.deadlineAt - Date.now());
  const timer = setTimeout(() => {
    // Synchronous, before any signal: from here on the exit poller must be
    // out of the way, or its natural-death inference could terminalize the
    // record as completed/failed while the kill is still in flight.
    options.beforeKill?.();
    void (async () => {
      if (record.status !== "running") return;
      if (record.pid !== undefined) await killPidTree(record.pid);
      await finalizeWorker({
        cwd: options.cwd,
        record,
        statusOverride: "timeout",
        errorOverride: adoptedTimeoutDetail(record),
        ...(options.events !== undefined ? { events: options.events } : {}),
        ...(options.onRecord !== undefined ? { onRecord: options.onRecord } : {}),
      });
      options.onSettled?.();
    })().catch((error) => {
      // Enforcement must never surface as an unhandled rejection. A later
      // janitor sweep can recover a record that remains running on disk.
      console.error(
        `[workers] adopted worker ${record.id} deadline enforcement failed: ${(error as Error).message}`,
      );
    });
  }, remaining);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

// --- Task composition ---

/**
 * Spawn-time ENVIRONMENT block appended to the task prompt: the provision
 * status plus the report_blocker instruction, so a worker blocked by a
 * missing environment tool reports the exact gap instead of trying to
 * install anything. The record's `task` keeps the original text; only the
 * spawned `-p` argument carries the block.
 */
export function composeWorkerTask(task: string, provision: ProvisionStatus | undefined): string {
  if (provision === undefined) return task;
  const status =
    provision.detail !== undefined ? `${provision.state} — ${provision.detail}` : provision.state;
  return `${task}\n\nENVIRONMENT: Provision: ${status}. If your task cannot proceed because something in this environment is missing, call report_blocker with the exact missing tool instead of trying to install anything.`;
}

// --- Runner ---

export interface StartWorkerOptions {
  cwd: string;
  task: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  name: string;
  timeoutMs: number;
  workerId: string;
  /** Extra `-e` extension paths loaded by the worker session. Worker tools
   *  route through worker-sandbox (loaded via extensionPaths); nothing here
   *  names a runtime. */
  extensionPaths: string[];
  /** Route the worker's built-in tools through the worker sandbox. */
  sandbox?: boolean;
  /** Investigation-only worker: read-only tools and filesystem. */
  readOnly?: boolean;
  /** Isolated worktree; when set the captured patch is stored on the record. */
  worktree?: { path: string; branch: string };
  /** Owning session identity, stamped on the record so artifact files can
   *  be classified after the session ends. */
  parentPid?: number;
  parentProcessStartedAt?: string;
  parentSessionId?: string;
  /** Provisioning outcome for this worker; appended to the task prompt as
   *  the ENVIRONMENT block and stamped on the record. */
  provision?: ProvisionStatus;
  /** Caller's abort signal: checked during preparation and directly before
   *  spawn. An abort before spawn rejects without creating a worker. */
  signal?: AbortSignal;
  events: WorkerEvents;
  /** Terminal persistence callback (transcript entry + record file). */
  onRecord(worker: WorkerRecord): Promise<unknown>;
}

export interface RunningWorker {
  record: WorkerRecord;
  /** Undefined when the spawn failed before a child existed; finalization
   *  then settles `done` with the failure. */
  child: ChildProcess | undefined;
  done: Promise<WorkerRecord>;
  cancel(): Promise<void>;
}

export async function startWorker(options: StartWorkerOptions): Promise<RunningWorker> {
  const { events } = options;
  const task = composeWorkerTask(options.task, options.provision);
  const startedAt = Date.now();
  const args = ["--mode", "json", "--no-session", "--no-extensions", "-p", task];
  if (options.model) args.push("--model", options.model);
  args.push("--thinking", options.thinkingLevel);
  for (const ext of options.extensionPaths) args.push("-e", ext);
  if (options.readOnly) args.push("--worker-readonly");

  const spoolFile = streamPath(options.cwd, options.workerId);
  const stderrFile = stderrLogPath(options.cwd, options.workerId);

  const record: WorkerRecord = {
    id: options.workerId,
    name: options.name,
    task: options.task,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    ...(options.parentPid !== undefined ? { parentPid: options.parentPid } : {}),
    ...(options.parentProcessStartedAt !== undefined
      ? { parentProcessStartedAt: options.parentProcessStartedAt }
      : {}),
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    cwd: options.worktree?.path ?? options.cwd,
    ...(options.worktree !== undefined
      ? { worktree: options.worktree.path, branch: options.worktree.branch }
      : {}),
    ...(options.provision !== undefined ? { provision: options.provision } : {}),
    status: "running",
    startedAt,
    // The durable counterpart of the in-memory timeout timer below: an
    // adopter re-arms the remaining time once this process is gone.
    deadlineAt: startedAt + options.timeoutMs,
    streamFormat: "raw",
  };

  // The child's stdio ARE the worker-directory files: no pipe connects it
  // to this process, so its output survives this process's death and any
  // session can read or finalize it. The parent tails the spool file for
  // live activity instead of reading a pipe.
  const childRef: { value?: ChildProcess } = {};
  let spawnError: Error | undefined;
  const assertNotAborted = () => {
    if (options.signal?.aborted)
      throw new SetupHookCancelled(
        abortReason(options.signal, "cancelled before the worker started"),
      );
  };
  const started = (async (): Promise<ChildProcess> => {
    assertNotAborted();
    await mkdir(join(spoolFile, ".."), { recursive: true });
    assertNotAborted();
    const taskSummary = summarizeStreamValue(options.task);
    await appendSpoolLine(options.cwd, options.workerId, {
      type: "workers_start",
      at: Date.now(),
      ...(taskSummary !== undefined ? { task: taskSummary } : {}),
    });
    assertNotAborted();
    const spoolHandle = await open(spoolFile, "a");
    let stderrHandle: import("node:fs/promises").FileHandle | undefined;
    try {
      stderrHandle = await open(stderrFile, "a");
      assertNotAborted();
      const child = spawn(workerBinary(), args, {
        cwd: options.worktree?.path ?? options.cwd,
        env: {
          ...cleanGitEnv(),
          PI_WORKER: "1",
          PI_WORKER_READONLY: options.readOnly ? "1" : "0",
          // Stable messenger identity: the worker is addressable in the mesh
          // by its workers-registry name instead of a generated themed name.
          PI_MESSENGER_NAME: options.name,
          // Shared registry and inbox; the child still uses its worktree cwd
          // for file tools and reservation path normalization.
          PI_MESSENGER_PROJECT_ROOT: options.cwd,
          // Blocker channel: the worker-side report_blocker tool appends
          // workers_blocker markers to this spool; the poller below ingests
          // them and wakes this session once, ids and status words only.
          [WORKER_STREAM_ENV_VAR]: spoolFile,
        },
        detached: true,
        // The child holds its own dups of these descriptors; the parent closes
        // its copies right after spawn.
        stdio: ["ignore", spoolHandle.fd, stderrHandle.fd],
      });
      // Exit wiring BEFORE any await: the child may outpace handle cleanup.
      wireChildEvents(child);
      childRef.value = child;
      return child;
    } finally {
      await spoolHandle.close().catch(() => {});
      await stderrHandle?.close().catch(() => {});
    }
  })().catch((error: Error) => {
    // Spawn-time failures (unreadable paths, ENOSPC on the spool) must not
    // reject into the completion chain: finalize as failed instead.
    spawnError = error;
    return undefined as unknown as ChildProcess;
  });

  if (childRef.value?.pid !== undefined) record.pid = childRef.value.pid;

  // Live activity: tail the spool the child is writing. Poll (not watch) is
  // deliberate — watch events are unreliable across platforms and the read
  // is idempotent from a byte offset.
  let ingestOffset = 0;
  let ingestBuffer = "";
  let lastActivityToolCount = 0;
  // A blocker wakes the parent exactly once, however many reports arrive.
  let blockerWakeSent = false;
  const ingestTimer = setInterval(() => {
    void ingestNewSpoolBytes(spoolFile).then((ingested) => {
      if (ingested === undefined) return;
      const [newBytes, nextOffset, skipped] = ingested;
      ingestOffset = nextOffset;
      if (skipped) ingestBuffer = "";
      const lines = `${ingestBuffer}${newBytes}`.split("\n");
      ingestBuffer = (lines.pop() ?? "").slice(-STREAM_TAIL_BYTES);
      if (skipped) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (ingestStreamEvent(line, record) === "blocker" && !blockerWakeSent) {
          blockerWakeSent = true;
          events.wake(
            `[worker ${record.name} (${record.id}) reported a blocker]. Use the workers tool (action=status, id=${record.id}) for details. If environmental, fix ${projectStateRelative("provision-worktree")} or ${projectStateRelative("sandbox.json")} in the parent checkout and re-delegate.`,
          );
        }
      }
      // The widget refreshes on activity changes (throttled by the root).
      const toolCount = record.activity?.toolCount ?? 0;
      if (toolCount !== lastActivityToolCount) {
        lastActivityToolCount = toolCount;
        events.onActivity();
      }
    });
  }, INGEST_POLL_MS);
  ingestTimer.unref?.();

  async function ingestNewSpoolBytes(path: string): Promise<[string, number, boolean] | undefined> {
    let handle: import("node:fs/promises").FileHandle;
    try {
      handle = await open(path, "r");
    } catch {
      return undefined;
    }
    try {
      const { size } = await handle.stat();
      if (size <= ingestOffset) return undefined;
      const start = Math.max(ingestOffset, size - STREAM_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return [buffer.toString("utf8"), size, start > ingestOffset];
    } finally {
      await handle.close().catch(() => {});
    }
  }

  let cancelRequested = false;
  let timedOut = false;
  let finishPromise: Promise<WorkerRecord> | undefined;

  /** Single-flight completion: the first terminal status wins. An undefined
   *  override lets finalizeWorker infer completed vs failed from the spool
   *  (no report → failed with the stderr tail as detail). */
  const finish = (
    statusOverride?: WorkerRecord["status"],
    errorOverride?: string,
  ): Promise<WorkerRecord> => {
    if (!finishPromise) {
      finishPromise = (async () => {
        clearInterval(ingestTimer);
        // Drain any spool bytes the poller has not ingested yet so the
        // activity snapshot in the terminal save is current.
        const ingested = await ingestNewSpoolBytes(spoolFile);
        if (ingested !== undefined) {
          const [bytes, , skipped] = ingested;
          const lines = `${skipped ? "" : ingestBuffer}${bytes}`.split("\n");
          if (skipped) lines.shift();
          for (const line of lines) {
            if (line.trim()) ingestStreamEvent(line, record);
          }
          ingestBuffer = "";
        }
        const child = await started;
        if (spawnError !== undefined || child === undefined) {
          record.status = "failed";
          record.endedAt = Date.now();
          record.error = spawnError?.message ?? "worker failed to spawn";
          await options.onRecord(record);
          events.notify(
            "error",
            `worker ${record.name} (${record.id}) failed to spawn: ${record.error}`,
          );
          return record;
        }
        return finalizeWorker({
          cwd: options.cwd,
          record,
          ...(statusOverride !== undefined ? { statusOverride } : {}),
          ...(errorOverride !== undefined ? { errorOverride } : {}),
          ...(options.worktree !== undefined ? { worktree: options.worktree } : {}),
          exitCode: child.exitCode,
          events,
          onRecord: options.onRecord,
        });
      })();
    }
    return finishPromise;
  };

  // The child's exit triggers finalization; its output is already on disk.
  // resolveDone is declared before the spawn so the wiring below can be
  // attached synchronously: a fast child can exit before the spawn IIFE's
  // handle-cleanup awaits resolve, and a listener attached only in .then
  // would miss 'close' entirely (done would never settle). The Promise
  // executor runs synchronously, so resolveDone is assigned before any
  // caller can observe `done`.
  let resolveDone: ((record: WorkerRecord) => void) | undefined;
  const done = new Promise<WorkerRecord>((resolve) => {
    resolveDone = resolve;
  });
  function settle(record: WorkerRecord): void {
    resolveDone?.(record);
  }

  /** Attach exit/timeout wiring to the child. Synchronous, called directly
   *  after spawn returns — never after an await. */
  function wireChildEvents(child: ChildProcess): void {
    const timeoutSeconds = Math.round(options.timeoutMs / 1000);
    const timer = setTimeout(() => {
      timedOut = true;
      // A spawn failure leaves child.pid undefined; killing is impossible
      // and killPidTree refuses non-positive pids anyway.
      if (child.pid !== undefined) void killPidTree(child.pid);
    }, options.timeoutMs);
    timer.unref?.();
    child.on("close", () => {
      clearTimeout(timer);
      const timedOutError = `worker exceeded ${timeoutSeconds}s timeout`;
      void finish(
        cancelRequested ? "cancelled" : timedOut ? "timeout" : undefined,
        timedOut && !cancelRequested ? timedOutError : undefined,
      ).then(settle);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      // The error override reaches finalizeWorker before persistence and
      // notification, so the saved record, the notify, and the caller all
      // carry the same cause.
      void finish("failed", err.message).then(settle);
    });
  }

  const cancel = async (): Promise<void> => {
    if (record.status !== "running") {
      // Terminal status precedes persistence; callers must not remove artifacts during the write.
      await finishPromise;
      return;
    }
    cancelRequested = true;
    const child = await started;
    // A failed spawn resolves `started` to undefined: nothing to signal, and
    // finish settles the failed record once below.
    if (child !== undefined && child.pid !== undefined) await killPidTree(child.pid);
    await finish("cancelled");
  };

  // The pid must be on the record before the caller's initial persist:
  // adoption, orphan detection, and pid-based kill all key off it.
  const child = await started;
  if (spawnError instanceof SetupHookCancelled) {
    clearInterval(ingestTimer);
    throw spawnError;
  }
  if (child === undefined) void finish("failed", spawnError?.message).then(settle);
  if (child !== undefined && child.pid !== undefined) record.pid = child.pid;
  return {
    record,
    child,
    done,
    cancel,
  };
}

/** Worker binary override (tests point this at a fixture script). */
function workerBinary(): string {
  return process.env.PI_WORKER_COMMAND?.trim() || "pi";
}
