/** Worker session types for the agents extension. */

import type { ThinkingLevel } from "pi";

// --- Types ---

export type WorkerStatus = "running" | "completed" | "failed" | "timeout" | "cancelled";

export interface WorkerRecord {
  id: string;
  name: string;
  task: string;
  model: string;
  /** Optional for compatibility with worker records created before thinking was configurable. */
  thinkingLevel?: ThinkingLevel;
  pid?: number;
  /** Owning session's process pid and session id: artifact files carry them
   *  so a later session can classify leftovers (live owner vs orphan). The
   *  transcript, not these fields, is the ownership authority. */
  parentPid?: number;
  parentSessionId?: string;
  /** Directory the worker session ran in (worktree path when isolated). */
  cwd: string;
  worktree?: string;
  branch?: string;
  status: WorkerStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Final assistant text extracted from the worker's JSON event stream. */
  outputText?: string;
  /** Path to the captured patch file (isolated workers only). */
  patchPath?: string;
  /** When the patch was applied to the main tree (collect action). */
  collectedAt?: number;
  error?: string;
  /** Latest activity snapshot from the worker's event stream (last tool +
   *  count). Updated in-memory while running; the terminal save records the
   *  last snapshot. */
  activity?: WorkerActivity;
  /** Roll-up of the worker's own token usage and cost, accumulated from the
   *  usage fields on its assistant messages (in-memory while running; the
   *  terminal save records the final totals). */
  usage?: WorkerUsage;
}

/** Compact live-activity snapshot; `detail` is a one-line arg summary. */
export interface WorkerActivity {
  tool: string;
  detail?: string;
  toolCount: number;
  at: number;
}

/** Accumulated token/cost totals across the worker's assistant messages. */
export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface WorkerRegistryFile {
  workers: Record<string, WorkerRecord>;
}

/** Callbacks the runner invokes around worker lifecycle changes. */
export interface WorkerEvents {
  /** Trusted wake: carries only ids/status words, never worker output. */
  wake(message: string): void;
  notify(level: "info" | "warning" | "error", message: string): void;
  onChange(): void;
  /** Stream activity happened (throttle before republishing the widget). */
  onActivity(): void;
}
