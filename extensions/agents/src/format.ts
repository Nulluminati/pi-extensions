/** Rendering for worker lists, status output, and the editor widget. */

import type { WorkerRecord } from "./types.ts";

// --- Constants ---

export const WORKERS_WIDGET_KEY = "agents";
export const AGENTS_STATE_EVENT = "agents:state";

// --- Formatting ---

const STATUS_ICONS: Record<WorkerRecord["status"], string> = {
  running: "◌",
  completed: "✓",
  failed: "✗",
  timeout: "⏱",
  cancelled: "⊘",
};

export function formatWorkerLine(worker: WorkerRecord): string {
  const icon = STATUS_ICONS[worker.status];
  const isolated = worker.worktree ? " [worktree]" : "";
  return `${icon} ${worker.id} "${worker.name}" ${worker.status} · ${worker.model}${isolated}`;
}

export function formatWorkerStatus(worker: WorkerRecord): string {
  const lines = [formatWorkerLine(worker), `Task: ${worker.task}`, `cwd: ${worker.cwd}`];
  if (worker.error !== undefined) lines.push(`Error: ${worker.error}`);
  if (worker.patchPath !== undefined) lines.push(`Patch: ${worker.patchPath}`);
  if (worker.outputText !== undefined) {
    lines.push("Report:", worker.outputText);
  } else if (worker.status === "running") {
    lines.push("Still running; check back after the wake message.");
  }
  return lines.join("\n");
}

export function formatWorkerList(workers: WorkerRecord[]): string {
  if (workers.length === 0) {
    return "No workers yet. Use the delegate tool to hand a task to a cheap-model worker session.";
  }
  return workers.map((w) => formatWorkerLine(w)).join("\n");
}

export function widgetLines(workers: WorkerRecord[]): string[] | undefined {
  if (workers.length === 0) return undefined;
  const lines = [`⚙ ${workers.length} worker(s)`];
  for (const w of workers.slice(0, 5)) lines.push(`  ${formatWorkerLine(w)}`);
  return lines;
}
