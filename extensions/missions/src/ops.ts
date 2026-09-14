/**
 * Pure mission operations. Each function validates its inputs and throws an
 * Error with a user-readable message on invalid usage; the tool/command layer
 * turns those into tool errors or UI notifications. Mutations bump
 * `updatedAt` via saveMission, not here.
 */

import { generateCheckpointId, generateTaskId } from "./storage.ts";
import type {
  Mission,
  MissionBudget,
  MissionStatus,
  MissionTask,
  ReconcileReport,
  TaskStatus,
  TaskVerification,
} from "./types.ts";

// --- Constants ---

const TASK_STATUSES: Set<string> = new Set([
  "todo",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "regressed",
]);

// --- Guards ---

export function requireOpen(mission: Mission): void {
  if (mission.status === "complete" || mission.status === "aborted") {
    throw new Error(`Mission ${mission.id} is ${mission.status}; it can no longer be modified.`);
  }
}

function findTask(mission: Mission, taskId: string): MissionTask {
  const task = mission.tasks.find((t) => t.id === taskId);
  if (!task) {
    const known = mission.tasks.map((t) => t.id).join(", ") || "none";
    throw new Error(`Unknown task ${taskId}. Known tasks: ${known}.`);
  }
  return task;
}

// --- Creation ---

export function createMission(
  id: string,
  title: string,
  objective: string,
  budget?: MissionBudget,
): Mission {
  const now = Date.now();
  return {
    id,
    title,
    objective,
    status: "planning",
    createdAt: now,
    updatedAt: now,
    tasks: [],
    checkpoints: [],
    decisions: [],
    budget: budget ?? {},
    spent: { iterations: 0, tokens: 0 },
  };
}

// --- Tasks ---

export interface TaskAddInput {
  title: string;
  dependsOn?: string[];
  owner?: string;
  verification?: TaskVerification;
}

export function addTask(mission: Mission, input: TaskAddInput): MissionTask {
  requireOpen(mission);
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required.");

  const deps = input.dependsOn ?? [];
  for (const dep of deps) {
    findTask(mission, dep); // throws on unknown dep
  }
  if (input.verification !== undefined && !input.verification.command.trim()) {
    throw new Error("Verification command must not be empty; omit verification instead.");
  }

  const task: MissionTask = {
    id: generateTaskId(),
    title,
    status: "todo",
    dependsOn: [...deps],
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.verification !== undefined
      ? {
          verification: {
            command: input.verification.command.trim(),
            ...(input.verification.description
              ? { description: input.verification.description }
              : {}),
          },
        }
      : {}),
  };
  mission.tasks.push(task);
  return task;
}

export interface TaskUpdateInput {
  taskId: string;
  status?: TaskStatus;
  summary?: string;
  owner?: string;
}

export function updateTask(mission: Mission, input: TaskUpdateInput): MissionTask {
  requireOpen(mission);
  const task = findTask(mission, input.taskId);

  if (input.status !== undefined) {
    if (!TASK_STATUSES.has(input.status)) {
      throw new Error(
        `Invalid task status "${input.status}". Valid: todo, in_progress, blocked, done, failed, regressed.`,
      );
    }
    if (input.status === "done") {
      const summary = (input.summary ?? task.summary ?? "").trim();
      if (!summary) {
        throw new Error(`Marking ${task.id} done requires a summary of what was delivered.`);
      }
      const unmet = task.dependsOn
        .map((dep) => findTask(mission, dep))
        .filter((dep) => dep.status !== "done");
      if (unmet.length > 0) {
        throw new Error(
          `${task.id} depends on ${unmet.map((d) => `${d.id} (${d.status})`).join(", ")}; finish those first.`,
        );
      }
      task.summary = summary;
    }
    task.status = input.status;
  }
  if (input.summary !== undefined && input.status !== "done") {
    const summary = input.summary.trim();
    if (summary) task.summary = summary;
    else delete task.summary;
  }
  if (input.owner !== undefined) {
    const owner = input.owner.trim();
    if (owner) task.owner = owner;
    else delete task.owner;
  }
  return task;
}

/** Attach or replace a task's verification command. */
export function setTaskVerification(
  mission: Mission,
  taskId: string,
  verification: TaskVerification | undefined,
): MissionTask {
  requireOpen(mission);
  const task = findTask(mission, taskId);
  if (verification === undefined) {
    delete task.verification;
  } else {
    const command = verification.command.trim();
    if (!command)
      throw new Error("Verification command must not be empty; pass undefined to clear.");
    task.verification = {
      command,
      ...(verification.description ? { description: verification.description } : {}),
    };
  }
  return task;
}

// --- Checkpoints, decisions, budget ---

export function addCheckpoint(
  mission: Mission,
  label: string,
  summary: string,
  commit?: string,
): { id: string } {
  requireOpen(mission);
  const trimmedLabel = label.trim();
  const trimmedSummary = summary.trim();
  if (!trimmedLabel) throw new Error("Checkpoint label is required.");
  if (!trimmedSummary) throw new Error("Checkpoint summary is required.");
  const id = generateCheckpointId();
  mission.checkpoints.push({
    id,
    label: trimmedLabel,
    summary: trimmedSummary,
    ...(commit?.trim() ? { commit: commit.trim() } : {}),
    at: Date.now(),
  });
  return { id };
}

export function addDecision(mission: Mission, text: string): void {
  requireOpen(mission);
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Decision text is required.");
  mission.decisions.push({ text: trimmed, at: Date.now() });
}

export function setBudget(mission: Mission, budget: MissionBudget): MissionBudget {
  requireOpen(mission);
  if (budget.maxIterations !== undefined && budget.maxIterations < 0) {
    throw new Error("maxIterations must be >= 0.");
  }
  if (budget.maxTokens !== undefined && budget.maxTokens < 0) {
    throw new Error("maxTokens must be >= 0.");
  }
  mission.budget = {
    ...(budget.maxIterations !== undefined ? { maxIterations: budget.maxIterations } : {}),
    ...(budget.maxTokens !== undefined ? { maxTokens: budget.maxTokens } : {}),
  };
  return mission.budget;
}

export function addSpend(
  mission: Mission,
  iterations: number | undefined,
  tokens: number | undefined,
): { overBudget: boolean; spent: Mission["spent"] } {
  requireOpen(mission);
  if (iterations !== undefined) {
    if (iterations < 0) throw new Error("iterations must be >= 0.");
    mission.spent.iterations += iterations;
  }
  if (tokens !== undefined) {
    if (tokens < 0) throw new Error("tokens must be >= 0.");
    mission.spent.tokens += tokens;
  }
  const overIterations =
    mission.budget.maxIterations !== undefined &&
    mission.spent.iterations > mission.budget.maxIterations;
  const overTokens =
    mission.budget.maxTokens !== undefined && mission.spent.tokens > mission.budget.maxTokens;
  return { overBudget: overIterations || overTokens, spent: { ...mission.spent } };
}

// --- Lifecycle ---

export function setStatus(mission: Mission, status: MissionStatus): void {
  if (status === "complete") {
    const open = mission.tasks.filter((t) => t.status !== "done" && t.status !== "failed");
    if (mission.tasks.length > 0 && open.length > 0) {
      throw new Error(
        `Cannot complete: ${open.map((t) => `${t.id} (${t.status})`).join(", ")} are not done. Mark or fail them first.`,
      );
    }
  }
  mission.status = status;
}

// --- Reconciliation ---

export interface VerificationRunner {
  /** Runs a verification command, resolving to pass/fail plus bounded output. */
  run(command: string, cwd: string): Promise<{ ok: boolean; output: string }>;
}

const RECONCILE_OUTPUT_CHARS = 800;

/**
 * Re-run every done task's verification command and flag regressions. Tasks
 * without verification are counted as skipped. Regressed tasks move to
 * status "regressed" so the record matches reality.
 */
export async function reconcileMission(
  mission: Mission,
  cwd: string,
  runner: VerificationRunner,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    missionId: mission.id,
    checked: 0,
    passed: 0,
    regressed: [],
    skippedNoVerification: 0,
  };

  for (const task of mission.tasks) {
    if (task.status !== "done") continue;
    const command = task.verification?.command;
    if (!command) {
      report.skippedNoVerification += 1;
      continue;
    }
    report.checked += 1;
    const { ok, output } = await runner.run(command, cwd);
    const bounded =
      output.length > RECONCILE_OUTPUT_CHARS
        ? `${output.slice(0, RECONCILE_OUTPUT_CHARS)}…[truncated]`
        : output;
    task.lastVerification = { ok, output: bounded, at: Date.now() };
    task.lastVerifiedAt = task.lastVerification.at;
    if (ok) {
      report.passed += 1;
    } else {
      task.status = "regressed";
      report.regressed.push({ taskId: task.id, title: task.title, output: bounded });
    }
  }
  return report;
}
