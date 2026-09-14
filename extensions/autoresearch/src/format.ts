/** Rendering for autoresearch status, results, and the footer line. */

import { formatStatusLine } from "../../../lib/ui-format.ts";
import { bestEntry, confidence } from "./stats.ts";
import type { AutoConfig, AutoSummary, RunEntry } from "./types.ts";

// --- Constants ---

export const AUTORESEARCH_STATUS_KEY = "autoresearch";
export const AUTORESEARCH_STATE_EVENT = "autoresearch:state";
export const AUTORESEARCH_STATUS_ICON = "⚗";
export const AUTORESEARCH_ICON_COLOR = "accent";
export const AUTORESEARCH_TEXT_COLOR = "muted";

// --- Summary ---

export function buildSummary(config: AutoConfig, entries: RunEntry[]): AutoSummary {
  const baseline = entries.find((e) => e.status === "baseline")?.metric;
  const best = bestEntry(
    entries.filter((e) => e.status !== "baseline"),
    config.direction,
  );
  const bestBaseline = bestEntry(entries, config.direction);
  const last = entries[entries.length - 1];
  const conf = confidence(entries, config.direction);
  return {
    active: config.stopped !== true,
    objective: config.objective,
    metric: config.metric,
    ...(config.unit !== undefined ? { unit: config.unit } : {}),
    direction: config.direction,
    iterations: entries.filter((e) => e.status === "keep" || e.status === "discard").length,
    ...(config.maxIterations !== undefined ? { maxIterations: config.maxIterations } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(best?.metric !== undefined
      ? { best: best.metric, bestRun: best.run }
      : bestBaseline?.metric !== undefined
        ? { best: bestBaseline.metric, bestRun: bestBaseline.run }
        : {}),
    ...(last !== undefined ? { lastStatus: last.status } : {}),
    ...(conf !== undefined ? { confidence: conf } : {}),
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
  if (summary.confidence !== undefined) {
    lines.push(
      `Confidence: ${round(summary.confidence)}x noise (${confidenceLabel(summary.confidence)})`,
    );
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

function confidenceLabel(value: number): string {
  if (value >= 2) return "likely real";
  if (value >= 1) return "marginal";
  return "within noise";
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Short footer text while the loop is active, or undefined when stopped. */
export function statusText(summary: AutoSummary): string | undefined {
  if (!summary.active) return undefined;
  const parts = [
    `it ${summary.iterations}${summary.maxIterations !== undefined ? `/${summary.maxIterations}` : ""}`,
  ];
  if (summary.best !== undefined) parts.push(`best ${round(summary.best)}`);
  if (summary.confidence !== undefined) parts.push(`conf ${round(summary.confidence)}x`);
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
