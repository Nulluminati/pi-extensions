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
}
