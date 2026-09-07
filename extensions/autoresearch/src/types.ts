/** Autoresearch state: experiment configuration and the append-only run log.
 * Everything lives under `<cwd>/.auto/` so a fresh session can resume from
 * files alone. */

// --- Types ---

export interface AutoConfig {
  objective: string;
  /** Metric name parsed from measure output (`METRIC name=value` or last number). */
  metric: string;
  unit?: string;
  /** Which direction is an improvement. */
  direction: "lower" | "higher";
  /** Shell command that measures the metric. */
  measure: string;
  /** Optional correctness gate run before measuring; failure blocks keep. */
  checks?: string;
  /** Stop after this many logged experiments (0 or absent = unlimited). */
  maxIterations?: number;
  /** Set when the loop is deactivated; config kept for the record. */
  stopped?: boolean;
  createdAt: number;
}

export type RunStatus = "baseline" | "keep" | "discard" | "checks_failed" | "invalid";

export interface RunEntry {
  run: number;
  at: number;
  status: RunStatus;
  description: string;
  hypothesis?: string;
  metric?: number;
  durationMs?: number;
  commit?: string;
  checksFailed?: boolean;
}

export interface AutoSummary {
  active: boolean;
  objective: string;
  metric: string;
  unit?: string;
  direction: "lower" | "higher";
  iterations: number;
  maxIterations?: number;
  baseline?: number;
  best?: number;
  bestRun?: number;
  lastStatus?: RunStatus;
  /** |best - baseline| relative to the noise floor (MAD), when computable. */
  confidence?: number;
}
