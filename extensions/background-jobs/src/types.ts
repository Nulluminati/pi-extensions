/**
 * Shared types for the background-jobs extension.
 *
 * The registry is intentionally in-memory and session-scoped: jobs live as
 * long as the Pi process. Output is spooled to disk per job so a future
 * restart-reconcile layer can adopt or audit past jobs without redesign.
 */

import type { ChildProcess } from "node:child_process";

export type JobKind = "background" | "monitor";

export type JobStatus =
  | "running"
  | "cancelling" // SIGTERM sent; awaiting exit or grace-expiry SIGKILL
  | "completed"
  | "failed"
  | "cancelled"
  | "satisfied" // monitor condition held
  | "timeout"
  | "kill_failed"; // SIGKILL did not reap the group within the grace window

export type SatisfyOn = "exit_zero" | "exit_nonzero" | "stdout_matches" | "stdout_not_matches";

export interface Job {
  id: number;
  kind: JobKind;
  label: string;
  command: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number | undefined;
  exitCode?: number | null | undefined;
  /** Rolling in-memory output buffer; the spool file on disk is the durable copy. */
  buffer: string;
  spoolPath?: string | undefined;
  // background
  child?: ChildProcess | undefined;
  pid?: number | undefined;
  wakeOnPattern?: RegExp | undefined;
  patternSource?: string | undefined;
  patternFired?: boolean | undefined;
  // monitor
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
  deadline?: number | undefined;
  satisfyOn?: SatisfyOn | undefined;
  pattern?: RegExp | undefined;
  patternSourceString?: string | undefined;
  /** In-flight guard so monitor polls never overlap. */
  polling?: boolean | undefined;
  pollFailures?: number | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/** Persisted projection of the registry, written via `pi.appendEntry`. */
export interface JobSnapshot {
  id: number;
  kind: JobKind;
  label: string;
  command: string;
  status: JobStatus;
  spoolPath?: string | undefined;
}

/** Callbacks the runner and monitor engines need from the composition root. */
export interface JobEvents {
  /**
   * Wake the agent with a trusted message. Callers must only interpolate
   * trusted data (job ids, exit codes, status words) — never command output,
   * which is attacker-controlled.
   */
  wake(message: string, details?: Record<string, unknown>): void;
  notify(level: "info" | "warning" | "error", message: string): void;
  /** Called after any registry mutation that should persist or refresh visuals. */
  onChange(): void;
}
