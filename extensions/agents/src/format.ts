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
  const base = `${icon} ${worker.id} "${worker.name}" ${worker.status} · ${worker.model}${isolated}`;
  if (worker.activity === undefined) return base;
  // Live activity: what the worker is doing right now (last started tool).
  const detail = worker.activity.detail !== undefined ? ` ${worker.activity.detail}` : "";
  return `${base} · ▸ ${worker.activity.tool}${detail}`;
}

export function formatWorkerStatus(worker: WorkerRecord): string {
  const lines = [formatWorkerLine(worker), `Task: ${worker.task}`, `cwd: ${worker.cwd}`];
  if (worker.usage !== undefined) {
    const tokens =
      worker.usage.inputTokens +
      worker.usage.outputTokens +
      worker.usage.cacheReadTokens +
      worker.usage.cacheWriteTokens;
    lines.push(`Usage: ${worker.usage.costUsd.toFixed(3)} · ${(tokens / 1000).toFixed(1)}k tok`);
  }
  if (worker.error !== undefined) lines.push(`Error: ${worker.error}`);
  if (worker.patchPath !== undefined) lines.push(`Patch: ${worker.patchPath}`);
  if (worker.outputText !== undefined) {
    lines.push("Report:", worker.outputText);
  } else if (worker.status === "running") {
    lines.push("Still running; workers action=tail shows its recent activity.");
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

// --- Stream tail ---

function shortTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human-readable lines from the parsed stream spool entries (newest last). */
export function formatStreamEntries(entries: string): string[] {
  const lines: string[] = [];
  for (const raw of entries.split("\n")) {
    if (!raw.trim()) continue;
    let event: {
      at?: number;
      kind?: string;
      tool?: string;
      detail?: string;
      text?: string;
      status?: string;
      error?: string;
      task?: string;
    };
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    const time = typeof event.at === "number" ? `${shortTime(event.at)} ` : "";
    if (event.kind === "assistant" && typeof event.text === "string") {
      lines.push(`${time}✎ ${event.text}`);
    } else if (event.kind === "tool_start" && typeof event.tool === "string") {
      const detail = typeof event.detail === "string" ? ` ${event.detail}` : "";
      lines.push(`${time}▸ ${event.tool}${detail}`);
    } else if (event.kind === "tool_end" && typeof event.tool === "string") {
      const detail = typeof event.detail === "string" ? ` ${event.detail}` : "";
      lines.push(`${time}✓ ${event.tool}${detail}`);
    } else if (event.kind === "start") {
      const task = typeof event.task === "string" ? ` ${event.task}` : "";
      lines.push(`${time}▷ started${task}`);
    } else if (event.kind === "end") {
      const suffix =
        (typeof event.status === "string" ? ` ${event.status}` : "") +
        (typeof event.error === "string" ? ` — ${event.error}` : "") +
        (typeof event.detail === "string" ? ` ${event.detail}` : "");
      lines.push(`${time}■ finished${suffix}`);
    }
  }
  return lines;
}
