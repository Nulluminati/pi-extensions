/** Loop statistics: best-so-far and MAD-based confidence that the best run
 * is a real improvement rather than benchmark noise. */

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
 * Confidence score: |best - baseline| divided by the robust noise floor
 * (1.4826 × MAD of all measured runs). >= 2 is likely real; < 1 is within
 * noise. Undefined when fewer than 3 measured runs or zero noise.
 */
export function confidence(entries: RunEntry[], direction: "lower" | "higher"): number | undefined {
  const measured = entries
    .filter((e) => e.metric !== undefined && e.status !== "invalid")
    .map((e) => e.metric as number);
  if (measured.length < 3) return undefined;
  const baseline = measured[0];
  if (baseline === undefined) return undefined;
  const best = bestEntry(entries, direction)?.metric;
  if (best === undefined) return undefined;
  const med = median(measured);
  const mad = median(measured.map((v) => Math.abs(v - med)));
  const noise = 1.4826 * mad;
  if (noise === 0) return undefined;
  return Math.abs(best - baseline) / noise;
}
