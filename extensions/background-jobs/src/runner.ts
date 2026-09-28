/**
 * Background job runner: spawns commands detached in their own process group,
 * captures output to a rolling buffer and a disk spool file, and wakes the
 * agent on exit (or the first pattern match). Cancellation escalates
 * SIGTERM → grace → SIGKILL against the process group and records the honest
 * outcome.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { appendBuffer, slugify } from "./format.ts";
import { createJob, finalizeJob, type JobRegistry } from "./registry.ts";
import type { Job, JobEvents } from "./types.ts";

export const CANCEL_GRACE_MS = 4_000; // SIGTERM grace before SIGKILL
export const KILL_GRACE_MS = 2_000; // post-SIGKILL reap window before kill_failed

/** Spool logs older than this are deleted when a session starts. */
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Newest spool logs kept regardless of age. */
export const SPOOL_MAX_FILES = 200;

export interface PruneSpoolOptions {
  maxAgeMs?: number;
  maxFiles?: number;
  /** Spool paths belonging to live jobs; never deleted. */
  keep?: ReadonlySet<string>;
}

/**
 * Bound the spool directory: delete logs past the age limit, then the oldest
 * files above the count cap. Live jobs' logs are always kept — a job that has
 * produced no output recently would otherwise look abandoned and be deleted
 * mid-run. Returns the number of files removed.
 */
export async function pruneSpoolDir(
  spoolDir: string,
  options: PruneSpoolOptions = {},
): Promise<number> {
  const maxAgeMs = options.maxAgeMs ?? SPOOL_MAX_AGE_MS;
  const maxFiles = options.maxFiles ?? SPOOL_MAX_FILES;
  const keep = options.keep ?? new Set<string>();

  let entries: Dirent[];
  try {
    entries = await readdir(spoolDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  const logs: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("job-") || !entry.name.endsWith(".log")) {
      continue;
    }
    const path = join(spoolDir, entry.name);
    if (keep.has(path)) continue;
    try {
      logs.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  const now = Date.now();
  const expired = logs.filter((log) => now - log.mtimeMs > maxAgeMs);
  const expiredPaths = new Set(expired.map((log) => log.path));
  const survivors = logs
    .filter((log) => !expiredPaths.has(log.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let deleted = 0;
  for (const log of [...expired, ...survivors.slice(Math.max(0, maxFiles))]) {
    try {
      await unlink(log.path);
      deleted += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return deleted;
}

export interface StartBackgroundOptions {
  registry: JobRegistry;
  command: string;
  cwd: string;
  label?: string | undefined;
  env?: Record<string, string> | undefined;
  /** When set, the agent is woken the first time output matches this regexp. */
  wakeOnPattern?: RegExp | undefined;
  patternSource?: string | undefined;
  /** Directory holding per-job spool files (created on demand). */
  spoolDir: string;
  events: JobEvents;
}

export async function startBackgroundJob(options: StartBackgroundOptions): Promise<Job> {
  const { registry, command, cwd, events } = options;
  const label = options.label ?? slugify(command);
  const job = createJob(registry, { kind: "background", label, command });

  await mkdir(options.spoolDir, { recursive: true });
  job.spoolPath = join(options.spoolDir, `job-${job.id}-${label}.log`);
  job.wakeOnPattern = options.wakeOnPattern;
  job.patternSource = options.patternSource;

  const child: ChildProcess = spawn(command, {
    shell: "/bin/sh",
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  job.pid = child.pid;

  const handleChunk = (data: Buffer | string): void => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    appendBuffer(job, text);
    // Spool write is best-effort; the buffer remains the source of truth.
    appendFile(job.spoolPath as string, text).catch((err: unknown) => {
      console.error(`[background-jobs] spool write failed: ${(err as Error).message}`);
    });
    if (job.wakeOnPattern && !job.patternFired && job.wakeOnPattern.test(text)) {
      job.patternFired = true;
      // Trusted wake: no command output, just the id and the matched fact.
      events.wake(
        `[background job #${job.id} "${label}" matched its wake_on_pattern — still running]. Read output with the jobs tool (action=tail, jobId=${job.id}).`,
      );
    }
  };
  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  child.on("exit", (code, signal) => {
    if (job.status === "cancelled" || job.status === "kill_failed") return;
    if (job.status === "cancelling") {
      // Reaped during cancellation (SIGTERM or SIGKILL worked).
      job.status = "cancelled";
      job.exitCode = code ?? null;
      finalizeJob(registry, job);
      events.onChange();
      return;
    }
    if (job.status !== "running") return; // double-fire guard

    job.exitCode = code;
    const ok = code === 0;
    job.status = ok ? "completed" : "failed";
    const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
    events.notify(
      ok ? "info" : "error",
      `background job #${job.id} "${label}" finished: ${reason}`,
    );
    // Trusted wake: only id, label, and the status word — never command output.
    events.wake(
      `[background job #${job.id} "${label}" finished: ${reason}]. Read its output with the jobs tool (action=tail, jobId=${job.id}).`,
    );
    finalizeJob(registry, job);
    events.onChange();
  });

  child.on("error", (err) => {
    if (job.status !== "running" && job.status !== "cancelling") return;
    job.status = "failed";
    events.notify("error", `background job #${job.id} "${label}" failed to spawn: ${err.message}`);
    events.wake(
      `[background job #${job.id} "${label}" failed to spawn: ${err.message}]. No command output was produced.`,
    );
    finalizeJob(registry, job);
    events.onChange();
  });

  events.onChange();
  return job;
}

/**
 * Stop a running job. SIGTERM the child's process group, wait for exit within
 * a grace window, then SIGKILL the group if it survived, waiting a second
 * short window for reaping. Records the honest outcome: cancelled (clean
 * exit) or kill_failed (still alive after SIGKILL). Idempotent for an
 * already-terminal job. Resolves once terminal.
 */
export async function cancelJob(registry: JobRegistry, job: Job): Promise<void> {
  if (job.status !== "running" && job.status !== "cancelling") return;
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = undefined;
  }
  if (!job.child || !job.pid) {
    // monitor (no child process) — terminal immediately.
    job.status = "cancelled";
    finalizeJob(registry, job);
    return;
  }

  job.status = "cancelling";
  const pid = job.pid;
  const child = job.child;

  const tryKill = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig); // negative pid = the whole process group
      return true;
    } catch {
      try {
        child.kill(sig);
        return true;
      } catch {
        return false; // already dead
      }
    }
  };

  const waitForExit = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const tick = (): void => {
        if (job.status !== "cancelling") {
          resolve(true); // exit handler reaped it
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        // NOTE: do NOT unref this timer. Once the child exits it becomes the
        // only ref'd handle; an unref'd poll would let the loop drain and the
        // next tick would never fire, hanging the await indefinitely.
        setTimeout(tick, 50);
      };
      tick();
    });

  tryKill("SIGTERM");
  if (await waitForExit(CANCEL_GRACE_MS)) {
    if (job.status === "cancelling") {
      job.status = "cancelled";
      finalizeJob(registry, job);
    }
    return;
  }
  if (job.status !== "cancelling") return; // reaped mid-window

  // Still alive after SIGTERM grace — escalate to SIGKILL and wait for reaping.
  const killed = tryKill("SIGKILL");
  if (!killed) {
    // Group was already gone (race with exit). Treat as cancelled.
    job.status = "cancelled";
    finalizeJob(registry, job);
    return;
  }
  if (await waitForExit(KILL_GRACE_MS)) {
    if (job.status === "cancelling") {
      job.status = "cancelled";
      finalizeJob(registry, job);
    }
    return;
  }

  // SIGKILL did not reap the group within the window — record honestly.
  if (job.status === "cancelling") {
    job.status = "kill_failed";
    finalizeJob(registry, job);
  }
}
