/** Worker session types for the workers extension. */

import type { ThinkingLevel } from "pi";
import type { WorkerBlocker } from "../../../lib/worker-blocker.ts";
import type { ProvisionStatus } from "./provision/types.ts";

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
  /** Worktree provisioning outcome (carry → share → provision), stamped at
   *  spawn and kept on failed records so remove/prune can render it. */
  provision?: ProvisionStatus;
  status: WorkerStatus;
  startedAt: number;
  /** Absolute hard-timeout deadline (epoch ms), armed at spawn as
   *  startedAt + timeout. An adopter re-arms the remaining time and kills
   *  the worker when it elapses; records created before this field existed
   *  carry no deadline and are never retroactively timed out. */
  deadlineAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Final assistant text extracted from the worker's JSON event stream. */
  outputText?: string;
  /** Blocker the worker reported via its report_blocker tool (one sanitized
   *  line, ingested from the spool). The wake carries no reason text; this
   *  field is what the workers tool (action=status) reads back. */
  blocker?: WorkerBlocker;
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
  /** Stream spool format. "raw" = the child's pi JSON event stream, written
   *  by the child itself to a file (survives parent death); absent = legacy
   *  parent-projected spool from before session-scoping. */
  streamFormat?: "raw";
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
