/** Rendering for worker lists, status output, and the editor widget. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { createFramedWidget, type FramedWidgetFactory } from "../../../lib/framed-widget.ts";
import { formatStatusLine } from "../../../lib/ui-format.ts";
import { BLOCKER_MARKER_TYPE } from "../../../lib/worker-blocker.ts";
import { physicalWorkerLabel } from "./physical-model.ts";
import { assistantTextFromContent, summarizeStreamValue } from "./stream-values.ts";
import type { WorkerRecord } from "./types.ts";

// --- Constants ---

export const WORKERS_WIDGET_KEY = "workers";
export const WORKERS_STATE_EVENT = "workers:state";

// Status-line fallback for pi's default footer (shown when the bundled
// status bar is disabled); registered in the status bar's line-2 skip list
// because the widget already shows the live state.
export const WORKERS_STATUS_KEY = "workers";
export const WORKERS_STATUS_ICON = "⚙";

/** How many workers the widget shows before collapsing the rest. */
const MAX_WIDGET_WORKERS = 5;

// --- Formatting ---

export const STATUS_ICONS: Record<WorkerRecord["status"], string> = {
  running: "◌",
  completed: "✓",
  failed: "✗",
  timeout: "⏱",
  cancelled: "⊘",
};

export function formatWorkerLine(worker: WorkerRecord, tag?: "orphan" | "other session"): string {
  const icon = STATUS_ICONS[worker.status];
  const isolated = worker.worktree ? " [worktree]" : "";
  const prefix = tag === undefined ? "" : `[${tag}] `;
  // A reported blocker is visible at list level so a stuck worker is
  // spottable without opening status.
  const blocked = worker.blocker !== undefined ? " · ⚠ blocker" : "";
  const physical = physicalWorkerLabel(worker.physicalModel);
  const model =
    physical && worker.physicalModel !== worker.model
      ? `${worker.model} → ${physical}`
      : worker.model;
  const base = `${prefix}${icon} ${worker.id} "${worker.name}" ${worker.status} · ${model}${isolated}`;
  if (worker.activity === undefined) return `${base}${blocked}`;
  // Live activity: what the worker is doing right now (last started tool).
  const detail = worker.activity.detail !== undefined ? ` ${worker.activity.detail}` : "";
  return `${base} · ▸ ${worker.activity.tool}${detail}${blocked}`;
}

export function formatWorkerStatus(worker: WorkerRecord): string {
  const lines = [formatWorkerLine(worker), `Task: ${worker.task}`, `cwd: ${worker.cwd}`];
  if (physicalWorkerLabel(worker.physicalModel)) {
    lines.push(`Physical model: ${worker.physicalModel}`);
    if (worker.physicalThinkingLevel !== undefined)
      lines.push(`Physical thinking: ${worker.physicalThinkingLevel}`);
  }
  if (worker.provision !== undefined) {
    const detail = worker.provision.detail !== undefined ? ` — ${worker.provision.detail}` : "";
    lines.push(`Provision: ${worker.provision.state}${detail}`);
  }
  if (worker.blocker !== undefined) lines.push(`Blocker: ${worker.blocker.reason}`);
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

/** Framed editor widget: the running workers, read at render time. */
export function createWorkersWidget(getWorkers: () => WorkerRecord[]): FramedWidgetFactory {
  return createFramedWidget({
    title: "Workers",
    titleRight: () => `${getWorkers().length} running`,
    getBodyLines: (theme) => {
      const workers = getWorkers();
      const lines = workers.slice(0, MAX_WIDGET_WORKERS).flatMap((worker) => {
        const physical = physicalWorkerLabel(worker.physicalModel);
        const rows = [formatWorkerLine(worker)];
        if (physical && worker.physicalModel !== worker.model) {
          const router = worker.model.slice(worker.model.lastIndexOf("/") + 1);
          rows.push(
            `  ${router} → ${physical}${worker.physicalThinkingLevel ? ` · ${worker.physicalThinkingLevel}` : ""}`,
          );
        }
        return rows;
      });
      if (workers.length > MAX_WIDGET_WORKERS)
        lines.push(theme.fg("dim", `↓ ${workers.length - MAX_WIDGET_WORKERS} more`));
      return lines;
    },
    maxBodyLines: MAX_WIDGET_WORKERS * 2 + 1,
  });
}

/** Short footer text for the running workers, or undefined when none. */
export function workersStatusText(running: number, costUsd: number): string | undefined {
  if (running <= 0) return undefined;
  // Same sub-cent floor as the status bar's spend roll-up so both surfaces
  // show the same figure for tiny costs.
  const cost = costUsd < 0.01 ? "<0.01" : costUsd.toFixed(2);
  return `${running} running · $${cost}`;
}

/** Themed status-line fallback (default footer) for the widget state. */
export function formatWorkersStatus(
  theme: Pick<Theme, "fg">,
  running: number,
  costUsd: number,
): string | undefined {
  const text = workersStatusText(running, costUsd);
  if (text === undefined) return undefined;
  return formatStatusLine(theme, {
    icon: WORKERS_STATUS_ICON,
    prefix: "Workers",
    text,
    iconColor: "accent",
    textColor: "muted",
  });
}

// --- Stream tail ---

function shortTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human-readable lines from the parsed stream spool entries (newest last).
 *  Legacy projected-spool format. */
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

interface RawSpoolEvent {
  type?: string;
  at?: number;
  message?: { role?: string; content?: unknown };
  toolName?: string;
  args?: unknown;
  result?: unknown;
  task?: string;
  status?: string;
  error?: string;
  reason?: string;
}

/** Human-readable lines from a raw child-written spool (pi JSON events plus
 *  workers_start/workers_end markers), newest last. Same visual language as
 *  the legacy projection: ▸ started tool, ✓ finished tool, ✎ text,
 *  ▷ started, ■ finished. */
export function formatRawStreamEntries(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: RawSpoolEvent;
    try {
      event = JSON.parse(line) as RawSpoolEvent;
    } catch {
      continue;
    }
    const time = typeof event.at === "number" ? `${shortTime(event.at)} ` : "";
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      const detail = summarizeStreamValue(event.args);
      out.push(`${time}▸ ${event.toolName}${detail !== undefined ? ` ${detail}` : ""}`);
    } else if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
      const detail = summarizeStreamValue(event.result);
      out.push(`${time}✓ ${event.toolName}${detail !== undefined ? ` ${detail}` : ""}`);
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = assistantTextFromContent(event.message.content);
      if (text) {
        const streamed = summarizeStreamValue(text);
        if (streamed !== undefined) out.push(`${time}✎ ${streamed}`);
      }
    } else if (event.type === "workers_start") {
      out.push(`${time}▷ started${typeof event.task === "string" ? ` ${event.task}` : ""}`);
    } else if (event.type === BLOCKER_MARKER_TYPE) {
      const reason = typeof event.reason === "string" ? ` ${event.reason}` : "";
      out.push(`${time}⚠ blocker${reason}`);
    } else if (event.type === "workers_end") {
      const suffix =
        (typeof event.status === "string" ? ` ${event.status}` : "") +
        (typeof event.error === "string" ? ` — ${event.error}` : "");
      out.push(`${time}■ finished${suffix}`);
    }
  }
  return out;
}
