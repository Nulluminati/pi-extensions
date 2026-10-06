/** Terminal-palette cards for the standalone, read-only Workers tab. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { STATUS_ICONS } from "../../workers/src/format.ts";
import type { WorkerSnapshot } from "./worker-view.ts";

// ANSI palette slots follow the terminal theme, including Herdr's terminal colors.
const COLORS: Record<string, number> = {
  accent: 36,
  borderAccent: 96,
  borderMuted: 90,
  dim: 90,
  muted: 90,
  text: 39,
  success: 32,
  error: 31,
  warning: 33,
};
export const workerViewTheme = {
  fg(color: string, text: string): string {
    return `\u001b[${COLORS[color] ?? 39}m${text}\u001b[39m`;
  },
};

const theme = workerViewTheme;

const STATES: Record<string, readonly [string, string]> = {
  running: [STATUS_ICONS.running, "warning"],
  completed: [STATUS_ICONS.completed, "success"],
  failed: [STATUS_ICONS.failed, "error"],
  timeout: [STATUS_ICONS.timeout, "warning"],
  cancelled: [STATUS_ICONS.cancelled, "muted"],
  unavailable: ["?", "muted"],
};

export function workersPageSize(height: number): number {
  return Math.min(8, Math.max(1, Math.floor((height - 5) / 9)));
}

function details(worker: WorkerSnapshot, rows: number): string[] {
  const lines = [
    theme.fg("dim", `${worker.id}${worker.model ? ` · ${worker.model}` : ""}`),
    theme.fg("muted", `Project: ${worker.cwd}`),
  ];
  if (worker.error) lines.push(theme.fg("error", `Error: ${worker.error}`));
  const activity = worker.activity.slice(-Math.min(2, Math.max(1, rows - lines.length)));
  const report = worker.report.slice(0, 2).map((line) => theme.fg("text", `Report: ${line}`));
  lines.push(...(worker.status === "running" ? activity.concat(report) : report.concat(activity)));
  if (worker.stderr.length) lines.push(theme.fg("error", `Stderr: ${worker.stderr[0]}`));
  if (lines.length === 2) lines.push(theme.fg("dim", "No recent activity."));
  return lines.slice(0, rows);
}

export function renderWorkersFrame(
  workers: readonly WorkerSnapshot[],
  total: number,
  page: number,
  width: number,
  height: number,
): string[] {
  const pageSize = workersPageSize(height);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const summary = theme.fg("muted", `Read-only · ${total} monitored · Page ${page + 1}/${pages}`);
  const hints =
    width >= 45
      ? formatStyledKeyHints(theme, [
          ["↑/↓", "pages"],
          ["q", "close monitor"],
        ])
      : formatStyledKeyHints(theme, [
          ["q", "close"],
          ["↑/↓", "pages"],
        ]);
  if (height < 4 || width < 4) {
    return [summary, ...workers.map((worker) => `${worker.id} · ${worker.status}`)]
      .slice(0, Math.max(0, height - 1))
      .concat(hints)
      .map((line) => truncateToWidth(line, width, ""));
  }
  const body = [summary];
  if (workers.length === 0) {
    body.push("", theme.fg("dim", "No monitored workers."), "", hints);
  } else if (height < 10 || width < 28) {
    for (const worker of workers) {
      body.push(`${worker.name} (${worker.id}) · ${worker.status}`);
      body.push(...worker.activity.slice(-1));
    }
    body.push(hints);
  } else {
    const cardWidth = modalContentWidth(width, 1);
    const cardHeight = Math.min(10, Math.floor((height - 5) / pageSize) - 1);
    body.push("");
    for (const [index, worker] of workers.entries()) {
      if (index) body.push("");
      const [icon, color] = STATES[worker.status] ?? ["?", "muted"];
      body.push(
        ...renderModalFrame(theme, cardWidth, details(worker, cardHeight - 2), {
          title: `${theme.fg(color, icon)} ${theme.fg("accent", truncateToWidth(worker.name, Math.max(1, cardWidth - visibleWidth(icon) - visibleWidth(worker.status) - 9)))}`,
          rawTitle: true,
          titleRight: theme.fg(color, worker.status),
          borderColor: "borderMuted",
          paddingX: 1,
          paddingY: 0,
          fixedBodyRows: cardHeight - 2,
        }),
      );
    }
    body.push("", hints);
  }
  // Keep the close hint on screen, even in a very short terminal.
  const budget = Math.max(1, height - 2);
  if (body.length > budget) body.splice(Math.max(0, budget - 1), body.length, hints);
  return renderModalFrame(theme, width, body, {
    title: "Workers",
    paddingX: 1,
    paddingY: 0,
  }).slice(0, height);
}
