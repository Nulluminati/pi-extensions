/**
 * Worker runner: spawns a child `pi --mode json --no-session -p <task>`
 * process in its own process group, streams stdout for assistant text, and
 * enforces a hard timeout. Wake-ups are trusted messages (ids and status
 * words only); worker output lives in the registry and is read via the
 * workers tool.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "pi";
import { cleanGitEnv } from "../../../lib/git.ts";
import { patchesDir, STREAM_MAX_BYTES, streamPath } from "./store.ts";
import type { WorkerActivity, WorkerEvents, WorkerRecord } from "./types.ts";
import { captureWorktreePatch } from "./worktree.ts";

// --- Constants ---

export const CANCEL_GRACE_MS = 4_000;
/** Arg/result summaries in the stream projection stay one line and short. */
export const STREAM_SUMMARY_CHARS = 200;

/** Worker binary override (tests point this at a fixture script). */
function workerBinary(): string {
  return process.env.PI_WORKER_COMMAND?.trim() || "pi";
}

// --- Stream projection ---

/** One filtered stream event (spooled as JSONL, read by workers tail). */
export interface StreamEvent {
  at: number;
  kind: "start" | "tool_start" | "tool_end" | "assistant" | "end";
  task?: string;
  tool?: string;
  detail?: string;
  text?: string;
  status?: string;
  error?: string;
}

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
  const raw = typeof preferred === "string" && preferred.trim() ? preferred : JSON.stringify(value);
  const oneLine = raw.replace(/\\?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > STREAM_SUMMARY_CHARS
    ? `${oneLine.slice(0, STREAM_SUMMARY_CHARS)}…`
    : oneLine;
}

/**
 * Bounded append-only spool of the worker's filtered event stream. Appends
 * are serialized to keep line order; past the size cap, appending stops and
 * a truncation marker is recorded (the head is preserved).
 */
class StreamSpool {
  private readonly path: string;
  private bytes = 0;
  private overflow = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(cwd: string, workerId: string) {
    this.path = streamPath(cwd, workerId);
  }

  write(event: StreamEvent): void {
    if (this.overflow) return;
    const line = `${JSON.stringify(event)}\n`;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > STREAM_MAX_BYTES) {
      this.overflow = true;
      this.enqueue({ at: Date.now(), kind: "end", detail: "stream truncated (size cap reached)" });
      return;
    }
    this.enqueue(event);
  }

  /** Resolves when all queued events are on disk (used at terminal save so
   *  the tail is complete the moment the worker finishes). */
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(event: StreamEvent): void {
    this.queue = this.queue
      .then(async () => {
        await mkdir(join(this.path, ".."), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
      })
      .catch((error) => {
        // A failed spool write must never affect the worker monitor; give up
        // on this worker's stream rather than retrying forever.
        this.overflow = true;
        console.error(`[agents] stream spool failed: ${(error as Error).message}`);
      });
  }
}

/**
 * Ingest one JSON event line from the worker's stdout: track live activity on
 * the record (last tool + running tool count), append to the stream spool,
 * and return the updated final-assistant text.
 */
export function ingestStreamEvent(
  jsonLine: string,
  current: string,
  record: WorkerRecord,
  spool: StreamSpool,
  events: WorkerEvents,
): string {
  let event: {
    type?: string;
    message?: { role?: string; content?: unknown; usage?: unknown };
    toolName?: string;
    args?: unknown;
    result?: unknown;
  };
  try {
    event = JSON.parse(jsonLine);
  } catch {
    return current;
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
    spool.write({
      at: activity.at,
      kind: "tool_start",
      tool: activity.tool,
      ...(detail !== undefined ? { detail } : {}),
    });
    events.onActivity();
    return current;
  }

  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    const at = Date.now();
    const toolEndDetail = summarizeStreamValue(event.result);
    spool.write({
      at,
      kind: "tool_end",
      tool: event.toolName,
      ...(toolEndDetail !== undefined ? { detail: toolEndDetail } : {}),
    });
    return current;
  }

  if (event.type !== "message_end" || event.message?.role !== "assistant") return current;
  // Roll up the worker's own token/cost usage (pi-ai Usage, per message).
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
  const content = event.message.content;
  if (!Array.isArray(content)) return current;
  const text = content
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
  if (text) {
    const streamed = summarizeStreamValue(text);
    if (streamed !== undefined) spool.write({ at: Date.now(), kind: "assistant", text: streamed });
  }
  return text || current;
}

// --- Parsing ---

/**
 * Extract the last assistant text from a pi JSON event stream. Each stdout
 * line is a JSON event; we keep the text of the most recent assistant
 * message_end so the final response wins.
 */
export function extractAssistantText(jsonLine: string, current: string): string {
  try {
    const event = JSON.parse(jsonLine) as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (event.type !== "message_end" || event.message?.role !== "assistant") return current;
    const content = event.message.content;
    if (!Array.isArray(content)) return current;
    const text = content
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
    return text || current;
  } catch {
    return current;
  }
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
  /** Extra `-e` extension paths loaded by the worker session. */
  extensionPaths: string[];
  /** Route the worker's built-in tools through a Gondolin VM (--gondolin). */
  sandbox?: boolean;
  /** Headless read-only enforcement (parent session is planning). */
  readOnly?: boolean;
  /** Isolated worktree; when set the captured patch is stored on the record. */
  worktree?: { path: string; branch: string };
  /** Owning session identity, stamped on the record so artifact files can
   *  be classified after the session ends. */
  parentPid?: number;
  parentSessionId?: string;
  events: WorkerEvents;
  /** Registry persistence callback (persist into .pi/workers). */
  onRecord(worker: WorkerRecord): Promise<void>;
}

export interface RunningWorker {
  record: WorkerRecord;
  child: ChildProcess;
  done: Promise<WorkerRecord>;
  cancel(): Promise<void>;
}

export function startWorker(options: StartWorkerOptions): RunningWorker {
  const { events } = options;
  const args = ["--mode", "json", "--no-session", "--no-extensions", "-p", options.task];
  if (options.model) args.push("--model", options.model);
  args.push("--thinking", options.thinkingLevel);
  for (const ext of options.extensionPaths) args.push("-e", ext);
  if (options.sandbox) args.push("--gondolin");
  if (options.readOnly) args.push("--worker-readonly");

  const child = spawn(workerBinary(), args, {
    cwd: options.worktree?.path ?? options.cwd,
    env: {
      ...cleanGitEnv(),
      PI_WORKER: "1",
      // Stable messenger identity: the worker is addressable in the mesh by
      // its agents-registry name instead of a generated themed name.
      PI_MESSENGER_NAME: options.name,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const record: WorkerRecord = {
    id: options.workerId,
    name: options.name,
    task: options.task,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    cwd: options.worktree?.path ?? options.cwd,
    ...(options.worktree !== undefined
      ? { worktree: options.worktree.path, branch: options.worktree.branch }
      : {}),
    ...(options.parentPid !== undefined ? { parentPid: options.parentPid } : {}),
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    status: "running",
    startedAt: Date.now(),
  };

  let stdoutText = "";
  // A JSON event line can be split across data events; hold the trailing
  // partial line until its newline arrives (or the stream closes). Decoding
  // is left to setEncoding, which buffers a multibyte UTF-8 sequence split
  // across chunk boundaries; per-chunk decoding would corrupt it.
  let stdoutLineBuffer = "";
  let stderrTail = "";
  const spool = new StreamSpool(options.cwd, options.workerId);
  const taskSummary = summarizeStreamValue(options.task);
  spool.write({
    at: Date.now(),
    kind: "start",
    ...(taskSummary !== undefined ? { task: taskSummary } : {}),
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutLineBuffer += chunk;
    const lines = stdoutLineBuffer.split("\n");
    stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      stdoutText = ingestStreamEvent(line, stdoutText, record, spool, events);
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
  });

  let cancelRequested = false;
  let timedOut = false;
  let finishPromise: Promise<WorkerRecord> | undefined;

  const doFinish = async (
    status: WorkerRecord["status"],
    exitCode: number | null,
    error?: string,
  ) => {
    if (record.status !== "running") return record;
    record.status = status;
    record.endedAt = Date.now();
    record.exitCode = exitCode;
    if (stdoutText) record.outputText = stdoutText;
    else delete record.outputText;
    if (error !== undefined) {
      record.error = error;
    } else {
      delete record.error;
    }
    const endError = summarizeStreamValue(error);
    spool.write({
      at: record.endedAt,
      kind: "end",
      status,
      ...(endError !== undefined ? { error: endError } : {}),
    });
    // Complete the stream before the terminal save so a post-mortem tail
    // always sees the end marker.
    await spool.flush();
    if (options.worktree !== undefined && (status === "completed" || status === "timeout")) {
      const patchPath = join(patchesDir(options.cwd), `${record.id}.diff`);
      try {
        await captureWorktreePatch(options.worktree.path, patchPath);
        record.patchPath = patchPath;
      } catch (err) {
        // Keep an earlier terminal error (e.g. the timeout reason) and append
        // the patch failure instead of overwriting it.
        const patchError = `patch capture failed: ${(err as Error).message}`;
        record.error = record.error !== undefined ? `${record.error}; ${patchError}` : patchError;
      }
    }
    await options.onRecord(record);
    events.onChange();
    return record;
  };

  /** Single-flight completion: the first terminal status wins. */
  const finish = (
    status: WorkerRecord["status"],
    exitCode: number | null,
    error?: string,
  ): Promise<WorkerRecord> => {
    if (!finishPromise) finishPromise = doFinish(status, exitCode, error);
    return finishPromise;
  };

  // The worker's terminal state is decided on `close`, not `exit`: Node can
  // emit `exit` before stdout is fully drained, and a patch captured while
  // the process is winding down misses its last writes. On timeout the child
  // is killed first; `close` then fires only after it has stopped and its
  // report and worktree are complete.
  const timeoutSeconds = Math.round(options.timeoutMs / 1000);
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, options.timeoutMs);

  const done = new Promise<WorkerRecord>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutLineBuffer !== "") {
        stdoutText = extractAssistantText(stdoutLineBuffer, stdoutText);
        stdoutLineBuffer = "";
      }
      const status = cancelRequested
        ? "cancelled"
        : timedOut
          ? "timeout"
          : code === 0 && stdoutText !== ""
            ? "completed"
            : "failed";
      const failure =
        status === "failed"
          ? stderrTail.trim() ||
            (code === 0 ? "worker exited without producing a report" : `exit ${code ?? "?"}`)
          : status === "timeout"
            ? `worker exceeded ${timeoutSeconds}s timeout`
            : status === "cancelled"
              ? "cancelled by user"
              : undefined;
      void finish(status, code, failure).then((w) => {
        if (w.status === "completed") {
          events.wake(
            `[worker ${w.name} (${w.id}) finished (exit ${code ?? "?"})]. Use the workers tool (action=status, id=${w.id}) to read its report${w.patchPath ? " and (action=collect) to apply its patch" : ""}.`,
          );
        } else if (w.status === "failed") {
          events.notify(
            "error",
            `worker ${w.name} (${w.id}) failed: ${w.error ?? "unknown error"}`,
          );
          // The wake carries ids and status words only; stderr detail stays
          // in the registry and is read on demand via the workers tool.
          events.wake(
            `[worker ${w.name} (${w.id}) failed]. Use the workers tool (action=status, id=${w.id}) for details.`,
          );
        } else if (w.status === "timeout") {
          events.notify("warning", `worker ${w.name} (${w.id}) timed out`);
          events.wake(
            `[worker ${w.name} (${w.id}) timed out after ${timeoutSeconds}s]. Use the workers tool (action=status, id=${w.id}) for details.`,
          );
        }
        resolve(w);
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      void finish("failed", null, err.message).then((w) => {
        events.notify("error", `worker ${w.name} (${w.id}) failed to spawn: ${err.message}`);
        resolve(w);
      });
    });
  });

  const cancel = async (): Promise<void> => {
    if (record.status !== "running") return;
    cancelRequested = true;
    clearTimeout(timer);
    await killTree(child);
    await finish("cancelled", null, "cancelled by user");
  };

  return { record, child, done, cancel };
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), CANCEL_GRACE_MS);
    }),
  ]);
  if (!exited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
