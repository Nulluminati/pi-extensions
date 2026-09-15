/** Human-readable rendering of mission state for tool results, commands,
 * the footer status line, and the editor widget. */

import { createFramedWidget, type FramedWidgetFactory } from "../../../lib/framed-widget.ts";
import { formatStatusLine } from "../../../lib/ui-format.ts";
import type { Mission, MissionSummary, ReconcileReport } from "./types.ts";

// --- Status line / widget ---

export const MISSION_STATUS_KEY = "missions";
export const MISSION_WIDGET_KEY = "missions";
export const MISSION_STATE_EVENT = "missions:state";
export const MISSION_STATUS_ICON = "◈";

/** Short footer text for the active mission, or undefined when none. */
export function statusText(mission: Mission | undefined): string | undefined {
  if (!mission) return undefined;
  return `${mission.status} · ${progressText(mission)}`;
}

/** Task progress for the widget's top-right label, e.g. "tasks 3/7 · 1 failing". */
export function progressText(mission: Mission): string {
  const done = mission.tasks.filter((t) => t.status === "done").length;
  const failed = mission.tasks.filter(
    (t) => t.status === "failed" || t.status === "regressed",
  ).length;
  const parts = [`tasks ${done}/${mission.tasks.length}`];
  if (failed > 0) parts.push(`${failed} failing`);
  return parts.join(" · ");
}

/** Task lines for the widget body, at most three per attention-needing status. */
function widgetTaskLines(mission: Mission): string[] {
  const show = (status: string) => mission.tasks.filter((t) => t.status === status).slice(0, 3);
  const lines: string[] = [];
  for (const task of show("in_progress")) lines.push(`  ▸ ${task.id} ${task.title}`);
  for (const task of show("blocked")) lines.push(`  ⛔ ${task.id} ${task.title} (blocked)`);
  for (const task of show("regressed")) lines.push(`  ⚠ ${task.id} ${task.title} (regressed)`);
  for (const task of show("failed")) lines.push(`  ✗ ${task.id} ${task.title} (failed)`);
  return lines;
}

/** Framed editor widget: the active mission and its attention-needing tasks,
 * or undefined when no mission is active. The mission is read at render time. */
export function createMissionWidget(getMission: () => Mission | undefined): FramedWidgetFactory {
  return createFramedWidget({
    title: "Mission",
    titleRight: () => {
      const mission = getMission();
      return mission ? progressText(mission) : undefined;
    },
    getBodyLines: () => {
      const mission = getMission();
      if (!mission) return [];
      return [
        `${MISSION_STATUS_ICON} ${mission.title} — ${mission.status}`,
        ...widgetTaskLines(mission),
      ];
    },
  });
}

/** Theme-formatted footer status entry. */
export function formatStatus(
  theme: { fg: (color: string, text: string) => string },
  mission: Mission | undefined,
): string | undefined {
  const text = statusText(mission);
  if (text === undefined) return undefined;
  return formatStatusLine(theme, {
    icon: MISSION_STATUS_ICON,
    prefix: "Mission",
    text,
    iconColor: "accent",
    textColor: "muted",
  });
}

// --- Detailed rendering ---

export function formatTaskLine(mission: Mission, index: number): string {
  const task = mission.tasks[index];
  if (!task) return "";
  const icons: Record<string, string> = {
    todo: "☐",
    in_progress: "▸",
    blocked: "⛔",
    done: "☑",
    failed: "✗",
    regressed: "⚠",
  };
  const icon = icons[task.status] ?? "·";
  const owner = task.owner ? ` [${task.owner}]` : "";
  const verification = task.verification ? " (verified)" : "";
  return `${icon} ${task.id} ${task.title}${owner}${verification}${task.summary ? `\n      ${task.summary}` : ""}`;
}

export function formatMissionStatus(mission: Mission): string {
  const lines: string[] = [
    `Mission ${mission.id}: ${mission.title}`,
    `Status: ${mission.status}`,
    `Objective: ${mission.objective}`,
  ];
  const budget: string[] = [];
  if (mission.budget.maxIterations !== undefined) {
    budget.push(`iterations ${mission.spent.iterations}/${mission.budget.maxIterations}`);
  }
  if (mission.budget.maxTokens !== undefined) {
    budget.push(`tokens ${mission.spent.tokens}/${mission.budget.maxTokens}`);
  }
  if (budget.length > 0) lines.push(`Budget: ${budget.join(", ")}`);

  if (mission.tasks.length === 0) {
    lines.push("Tasks: none yet");
  } else {
    lines.push(`Tasks (${mission.tasks.length}):`);
    for (let i = 0; i < mission.tasks.length; i++) {
      lines.push(`  ${formatTaskLine(mission, i)}`);
    }
  }

  if (mission.checkpoints.length > 0) {
    lines.push("Checkpoints:");
    for (const cp of mission.checkpoints.slice(-5)) {
      lines.push(`  ◈ ${cp.label}${cp.commit ? ` @ ${cp.commit}` : ""}: ${cp.summary}`);
    }
  }
  if (mission.decisions.length > 0) {
    lines.push("Decisions:");
    for (const d of mission.decisions.slice(-5)) lines.push(`  • ${d.text}`);
  }
  return lines.join("\n");
}

export function formatMissionSummaries(summaries: MissionSummary[]): string {
  if (summaries.length === 0)
    return "No missions. Use the mission tool (action=create) to start one.";
  return summaries
    .map((s) => {
      const done = s.taskCounts.done ?? 0;
      const total = Object.values(s.taskCounts).reduce((a, b) => a + b, 0);
      const active = s.taskCounts.in_progress ?? 0;
      const failing = (s.taskCounts.failed ?? 0) + (s.taskCounts.regressed ?? 0);
      const flags: string[] = [];
      if (active > 0) flags.push(`${active} active`);
      if (failing > 0) flags.push(`${failing} failing`);
      return `${s.id} [${s.status}] ${s.title} — ${done}/${total} done${flags.length ? ` (${flags.join(", ")})` : ""}`;
    })
    .join("\n");
}

export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [
    `Reconciled ${report.missionId}: ${report.checked} verified task(s) re-checked, ${report.passed} passed.`,
  ];
  if (report.skippedNoVerification > 0) {
    lines.push(
      `${report.skippedNoVerification} done task(s) have no verification command and were skipped.`,
    );
  }
  if (report.regressed.length === 0) {
    lines.push("No regressions.");
  } else {
    lines.push(`${report.regressed.length} task(s) REGRESSED and were marked regressed:`);
    for (const r of report.regressed) {
      lines.push(`  ⚠ ${r.taskId} ${r.title}`);
      lines.push(`      ${r.output.split("\n").join("\n      ")}`);
    }
  }
  return lines.join("\n");
}
