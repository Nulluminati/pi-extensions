/** Rendering for worker lists, status output, and the editor widget. */

import { createFramedWidget, type FramedWidgetFactory } from "../../../lib/framed-widget.ts";
import type { WorkerRecord } from "./types.ts";

// --- Constants ---

export const WORKERS_WIDGET_KEY = "agents";
export const AGENTS_STATE_EVENT = "agents:state";

/** How many workers the widget shows before collapsing the rest. */
const MAX_WIDGET_WORKERS = 5;

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

/** Framed editor widget: the running workers, read at render time. */
export function createWorkersWidget(getWorkers: () => WorkerRecord[]): FramedWidgetFactory {
  return createFramedWidget({
    title: "Workers",
    titleRight: () => `${getWorkers().length} running`,
    getBodyLines: () => getWorkers().map(formatWorkerLine),
    maxBodyLines: MAX_WIDGET_WORKERS,
  });
}
