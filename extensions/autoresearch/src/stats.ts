/** Loop statistics: best-so-far over baseline + kept runs and a descriptive
 * spread score. The spread number is NOT a confidence measure: its MAD mixes
 * treatment effects with run-to-run variation, so it describes observed
 * spread and must never be labeled real/noise. */

import type { RunEntry } from "./types.ts";

// --- Stats ---

export function bestEntry(
  entries: RunEntry[],
  direction: "lower" | "higher",
): RunEntry | undefined {
  const measured = entries.filter((e) => e.metric !== undefined && e.status !== "invalid");
  if (measured.length === 0) return undefined;
  return measured.reduce((best, e) => {
    if (best.metric === undefined || e.metric === undefined) return best;
    const better = direction === "lower" ? e.metric < best.metric : e.metric > best.metric;
    return better ? e : best;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 1) {
    return upper ?? Number.NaN;
  }
  if (lower === undefined || upper === undefined) return Number.NaN;
  return (lower + upper) / 2;
}

/**
 * Descriptive spread score: |best - baseline| divided by 1.4826 × MAD of the
 * measured runs. Every measured run comes from a different code revision, so
 * this number mixes treatment effects with run-to-run variation and CANNOT
 * distinguish a real improvement from noise — it only describes how large the
 * best-vs-baseline delta is relative to the observed spread. Undefined when
 * fewer than 3 measured runs or zero spread.
 */
export function spreadScore(
  entries: RunEntry[],
  direction: "lower" | "higher",
): number | undefined {
  // Kept runs and the baseline only: discarded runs were reverted and are not
  // in the working tree, so they would skew both the best and the spread.
  const kept = entries.filter(
    (e) => e.metric !== undefined && e.status !== "invalid" && e.status !== "discard",
  );
  const measured = kept.map((e) => e.metric as number);
  if (measured.length < 3) return undefined;
  const baseline = measured[0];
  if (baseline === undefined) return undefined;
  const best = bestEntry(kept, direction)?.metric;
  if (best === undefined) return undefined;
  const med = median(measured);
  const mad = median(measured.map((v) => Math.abs(v - med)));
  const noise = 1.4826 * mad;
  if (noise === 0) return undefined;
  return Math.abs(best - baseline) / noise;
}
