/** Widget rendering for background jobs: pure line building plus the framed
 * editor-widget factory, styled like the todos widget. */

import { createFramedWidget, type FramedWidgetFactory } from "../../../lib/framed-widget.ts";
import { activeJobs, type JobRegistry } from "./registry.ts";

/** How many jobs the widget shows before collapsing the rest. */
const MAX_WIDGET_ITEMS = 3;

const WIDGET_TITLE = "Jobs";

export interface WidgetTheme {
  fg(color: string, text: string): string;
}

/** One `#id label` line; cancelling jobs note their state. */
export function jobLine(theme: WidgetTheme, job: { id: number; label: string; status: string }) {
  const suffix = job.status === "cancelling" ? theme.fg("warning", " (cancelling)") : "";
  return `${theme.fg("dim", `#${job.id}`)} ${job.label}${suffix}`;
}

/** Progress label for the frame's top-right cell, e.g. "2 running". */
export function buildProgressLabel(count: number): string {
  return `${count} running`;
}

/**
 * Widget body lines: active jobs only, at most maxItems plus a "↓ N more"
 * indicator. Jobs are read from the registry at render time so the box always
 * shows the current set.
 */
export function buildWidgetLines(
  theme: WidgetTheme,
  registry: JobRegistry,
  maxItems = MAX_WIDGET_ITEMS,
): string[] {
  const active = activeJobs(registry);
  const visible = active.slice(0, maxItems);
  const hidden = active.length - visible.length;
  const lines = visible.map((job) => jobLine(theme, job));
  if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
  return lines;
}

/**
 * Editor-widget factory: the active jobs in a framed box above the editor,
 * the same border language as the todos panel.
 */
export function createJobsWidget(registry: JobRegistry): FramedWidgetFactory {
  return createFramedWidget({
    title: WIDGET_TITLE,
    titleRight: () => buildProgressLabel(activeJobs(registry).length),
    getBodyLines: (theme) => buildWidgetLines(theme, registry),
  });
}
