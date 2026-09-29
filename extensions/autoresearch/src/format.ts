/** Rendering for autoresearch status, results, and the footer line. */

import { createFramedWidget, type FramedWidgetFactory } from "../../../lib/framed-widget.ts";
import { formatStatusLine } from "../../../lib/ui-format.ts";
import { bestEntry, spreadScore } from "./stats.ts";
import type { AutoConfig, AutoSummary, RunEntry } from "./types.ts";

// --- Constants ---

export const AUTORESEARCH_STATUS_KEY = "autoresearch";
export const AUTORESEARCH_WIDGET_KEY = "autoresearch";
export const AUTORESEARCH_STATE_EVENT = "autoresearch:state";
const AUTORESEARCH_STATUS_ICON = "⚗";
const AUTORESEARCH_ICON_COLOR = "accent";
const AUTORESEARCH_TEXT_COLOR = "muted";

// --- Summary ---

export function buildSummary(config: AutoConfig, entries: RunEntry[]): AutoSummary {
  const baseline = entries.find((e) => e.status === "baseline")?.metric;
  // The headline best comes from the baseline plus kept runs only: discarded
  // runs were reverted and are not present in the working tree, and a kept
  // regression must not displace the baseline as the best known state.
  const best = bestEntry(
    entries.filter((e) => e.status === "baseline" || e.status === "keep"),
    config.direction,
  );
  const last = entries[entries.length - 1];
  const spread = spreadScore(entries, config.direction);
  return {
    active: config.stopped !== true,
    objective: config.objective,
    metric: config.metric,
    ...(config.unit !== undefined ? { unit: config.unit } : {}),
    direction: config.direction,
    iterations: entries.filter((e) => e.status === "keep" || e.status === "discard").length,
    ...(config.maxIterations !== undefined ? { maxIterations: config.maxIterations } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(best?.metric !== undefined ? { best: best.metric, bestRun: best.run } : {}),
    ...(last !== undefined ? { lastStatus: last.status } : {}),
    ...(spread !== undefined ? { spread } : {}),
  };
}

// --- Formatting ---

export function formatSummary(summary: AutoSummary, recent: RunEntry[]): string {
  const lines = [
    `Autoresearch ${summary.active ? "ACTIVE" : "STOPPED"}: ${summary.objective}`,
    `Metric: ${summary.metric}${summary.unit ? ` (${summary.unit})` : ""} — ${summary.direction === "lower" ? "lower is better" : "higher is better"}`,
  ];
  if (summary.baseline !== undefined) lines.push(`Baseline: ${summary.baseline}`);
  if (summary.best !== undefined) {
    lines.push(`Best: ${summary.best} (run ${summary.bestRun})`);
    if (summary.baseline !== undefined) {
      const delta = summary.best - summary.baseline;
      lines.push(`Delta vs baseline: ${delta > 0 ? "+" : ""}${round(delta)}`);
    }
  }
  const cap = summary.maxIterations !== undefined ? `/${summary.maxIterations}` : "";
  lines.push(`Iterations: ${summary.iterations}${cap}`);
  if (summary.spread !== undefined) {
    lines.push(`Spread: ${round(summary.spread)}x MAD`);
  }
  if (recent.length > 0) {
    lines.push("Recent runs:");
    for (const e of recent.slice(-5)) {
      const metric = e.metric !== undefined ? ` metric=${round(e.metric)}` : "";
      lines.push(`  #${e.run} ${e.status}${metric}: ${e.description}`);
    }
  }
  return lines.join("\n");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Short footer text while the loop is active, or undefined when stopped. */
function statusText(summary: AutoSummary): string | undefined {
  if (!summary.active) return undefined;
  const parts = [
    `it ${summary.iterations}${summary.maxIterations !== undefined ? `/${summary.maxIterations}` : ""}`,
  ];
  if (summary.best !== undefined) parts.push(`best ${round(summary.best)}`);
  if (summary.spread !== undefined) parts.push(`spread ${round(summary.spread)}x`);
  return parts.join(" · ");
}

/** Theme-formatted footer status entry, or undefined when not running. */
export function formatFooter(
  theme: { fg: (color: string, text: string) => string },
  summary: AutoSummary | undefined,
): string | undefined {
  const text = summary ? statusText(summary) : undefined;
  if (text === undefined) return undefined;
  return formatStatusLine(theme, {
    icon: AUTORESEARCH_STATUS_ICON,
    prefix: "Autoresearch",
    text,
    iconColor: AUTORESEARCH_ICON_COLOR,
    textColor: AUTORESEARCH_TEXT_COLOR,
  });
}

// --- Widget ---

/** Framed editor widget: campaign progress and the latest run. The summary
 * and log snapshot are read at render time from what the last publish gave. */
export function createAutoresearchWidget(
  getState: () => { summary: AutoSummary; entries: RunEntry[] } | undefined,
): FramedWidgetFactory {
  return createFramedWidget({
    title: "Autoresearch",
    titleRight: () => {
      const state = getState();
      if (!state) return undefined;
      const { iterations, maxIterations } = state.summary;
      return `it ${iterations}${maxIterations !== undefined ? `/${maxIterations}` : ""}`;
    },
    getBodyLines: () => {
      const state = getState();
      if (!state) return [];
      const { summary, entries } = state;
      const lines: string[] = [];
      const bestParts: string[] = [];
      if (summary.best !== undefined) bestParts.push(`best ${round(summary.best)}`);
      if (summary.spread !== undefined) bestParts.push(`spread ${round(summary.spread)}x`);
      if (bestParts.length > 0) lines.push(bestParts.join(" · "));
      const last = entries[entries.length - 1];
      if (last) {
        lines.push(`run ${last.run} ${last.status}: ${last.description.split("\n")[0]}`);
      }
      return lines;
    },
  });
}
