/** Durable mission state. A mission is a long-lived objective with a task
 * graph, checkpoints, decisions, and a budget, persisted as JSON in the
 * project so it survives restarts and can be reconciled against reality. */

// --- Types ---

export type MissionStatus = "planning" | "active" | "paused" | "complete" | "aborted";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "failed" | "regressed";

export interface TaskVerification {
  /** Shell command that must exit 0 for the task to count as verified. */
  command: string;
  /** Optional human description of what the command proves. */
  description?: string;
}

export interface MissionTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Task ids that must be done before this task can be marked done. */
  dependsOn: string[];
  /** "main" or "worker:<name>" — who owns delivering this task. */
  owner?: string;
  /** What was actually delivered; required when marking a task done. */
  summary?: string;
  verification?: TaskVerification;
  lastVerifiedAt?: number;
  lastVerification?: { ok: boolean; output: string; at: number };
}

export interface MissionCheckpoint {
  id: string;
  label: string;
  summary: string;
  commit?: string;
  at: number;
}

export interface MissionDecision {
  text: string;
  at: number;
}

export interface MissionBudget {
  maxIterations?: number;
  maxTokens?: number;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  tasks: MissionTask[];
  checkpoints: MissionCheckpoint[];
  decisions: MissionDecision[];
  budget: MissionBudget;
  spent: { iterations: number; tokens: number };
}

export interface MissionSummary {
  id: string;
  title: string;
  status: MissionStatus;
  updatedAt: number;
  taskCounts: Record<TaskStatus, number>;
}

/** Result of listing missions: readable summaries plus files that were skipped. */
export interface MissionListResult {
  summaries: MissionSummary[];
  /** Filenames of mission files that could not be read (corrupt content). */
  skipped: string[];
}

/** Result of re-running verification commands for a mission's done tasks. */
export interface ReconcileReport {
  missionId: string;
  checked: number;
  passed: number;
  regressed: Array<{ taskId: string; title: string; output: string }>;
  /** Done tasks whose verification command was refused before it ran. */
  blocked: Array<{ taskId: string; title: string; output: string }>;
  skippedNoVerification: number;
}
