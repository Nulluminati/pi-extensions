/** Rendering of eval results and summary reports. */

import type { EvalResult } from "./types.ts";

// --- Constants ---

export const EVALS_STATE_EVENT = "harness-evals:state";

// --- Formatting ---

export function formatResult(result: EvalResult): string {
  const status = result.pass ? "PASS" : "FAIL";
  const lines = [
    `${status} ${result.taskId} (${Math.round(result.durationMs / 1000)}s, ${result.inputTokens}in/${result.outputTokens}out tokens, model ${result.model})`,
  ];
  for (const check of result.checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.name}`);
    if (!check.ok) {
      lines.push(`    ${check.output.split("\n").join("\n    ")}`);
    }
  }
  if (result.timedOut) lines.push("  (session timed out)");
  if (result.error !== undefined) lines.push(`  error: ${result.error}`);
  return lines.join("\n");
}

export interface SuiteSummary {
  runs: number;
  passes: number;
  passRate: number;
  byTask: Array<{
    taskId: string;
    runs: number;
    passes: number;
    avgSeconds: number;
    avgOutputTokens: number;
  }>;
}

export function summarize(results: EvalResult[]): SuiteSummary {
  const byTask = new Map<
    string,
    { runs: number; passes: number; totalMs: number; totalOut: number }
  >();
  for (const r of results) {
    const entry = byTask.get(r.taskId) ?? { runs: 0, passes: 0, totalMs: 0, totalOut: 0 };
    entry.runs += 1;
    if (r.pass) entry.passes += 1;
    entry.totalMs += r.durationMs;
    entry.totalOut += r.outputTokens;
    byTask.set(r.taskId, entry);
  }
  return {
    runs: results.length,
    passes: results.filter((r) => r.pass).length,
    passRate: results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length,
    byTask: [...byTask.entries()]
      .map(([taskId, e]) => ({
        taskId,
        runs: e.runs,
        passes: e.passes,
        avgSeconds: Math.round(e.totalMs / e.runs / 100) / 10,
        avgOutputTokens: Math.round(e.totalOut / e.runs),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
  };
}

export function formatSummary(summary: SuiteSummary): string {
  const lines = [
    `Harness eval results: ${summary.passes}/${summary.runs} passed (${Math.round(summary.passRate * 100)}%)`,
  ];
  for (const t of summary.byTask) {
    lines.push(
      `  ${t.taskId}: ${t.passes}/${t.runs} pass · avg ${t.avgSeconds}s · avg out ${t.avgOutputTokens} tok`,
    );
  }
  return lines.join("\n");
}
