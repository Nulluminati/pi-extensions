/**
 * Worker runner: spawns a child `pi --mode json --no-session -p <task>`
 * process in its own process group, streams stdout for assistant text, and
 * enforces a hard timeout. Wake-ups are trusted messages (ids and status
 * words only); worker output lives in the registry and is read via the
 * workers tool.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { cleanGitEnv } from "../../../lib/git.ts";
import { patchesDir } from "./store.ts";
import type { WorkerEvents, WorkerRecord } from "./types.ts";
import { captureWorktreePatch } from "./worktree.ts";

// --- Constants ---

export const CANCEL_GRACE_MS = 4_000;

/** Worker binary override (tests point this at a fixture script). */
function workerBinary(): string {
  return process.env.PI_WORKER_COMMAND?.trim() || "pi";
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
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    cwd: options.worktree?.path ?? options.cwd,
    ...(options.worktree !== undefined
      ? { worktree: options.worktree.path, branch: options.worktree.branch }
      : {}),
    status: "running",
    startedAt: Date.now(),
  };

  let stdoutText = "";
  let stderrTail = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      stdoutText = extractAssistantText(line, stdoutText);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });

  let cancelRequested = false;
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
    if (options.worktree !== undefined && (status === "completed" || status === "timeout")) {
      const patchPath = join(patchesDir(options.cwd), `${record.id}.diff`);
      try {
        await captureWorktreePatch(options.worktree.path, patchPath);
        record.patchPath = patchPath;
      } catch (err) {
        record.error = `patch capture failed: ${(err as Error).message}`;
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

  const timer = setTimeout(() => {
    void finish(
      "timeout",
      null,
      `worker exceeded ${Math.round(options.timeoutMs / 1000)}s timeout`,
    ).then(async (w) => {
      await killTree(child);
      events.notify("warning", `worker ${w.name} (${w.id}) timed out`);
      events.wake(
        `[worker ${w.name} (${w.id}) timed out after ${Math.round(options.timeoutMs / 1000)}s]. Use the workers tool (action=status, id=${w.id}) for details.`,
      );
    });
  }, options.timeoutMs);

  const done = new Promise<WorkerRecord>((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(timer);
      const status = cancelRequested ? "cancelled" : code === 0 ? "completed" : "failed";
      const failure = status === "failed" ? stderrTail.trim() || `exit ${code ?? "?"}` : undefined;
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
