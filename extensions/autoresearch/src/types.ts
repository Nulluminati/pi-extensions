/** Autoresearch state: experiment configuration and the append-only run log.
 * Everything lives under `<cwd>/.pi/autoresearch/` so a fresh session can
 * resume from files alone. */

import type { ExtensionContext } from "pi";

// --- Types ---

/** A measurement observed by `run` and awaiting keep/discard by `log`. */
export interface PendingMeasurement {
  run: number;
  metric?: number;
  durationMs: number;
  description: string;
  hypothesis?: string;
}

/** Per-Pi-instance state, owned by the composition root and passed explicitly
 *  to modules: the pending-measurement slot plus continuation-loop guards. */
export interface InstanceState {
  /** In-memory pending measurement between `run` and `log`. */
  pending?: PendingMeasurement | undefined;
  /** Autoresearch tool calls this session; engagement signal for the stall guard. */
  toolActivity: number;
  lastSeenActivity: number;
  continuationQueued: boolean;
  idleWakes: number;
}

/** Loose tool-call parameters; fields are narrowed at runtime against
 *  AUTORESEARCH_PARAMETERS in schemas.ts. */
export type AutoresearchParams = Record<string, unknown>;

/** Publish campaign state to the state event, footer status, and widget. */
export type PublishFn = (
  ctx: ExtensionContext,
  config: AutoConfig | undefined,
  entries: RunEntry[],
) => void;

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
  /** Session that created the campaign; only it drives the continuation
   *  loop. Absent on legacy configs, which any session may continue. */
  ownerSessionId?: string;
  /** Tracked files that were already dirty when the campaign started.
   *  Keeps never stage them and discards never restore them. Normally
   *  empty: init refuses to start while tracked files are dirty. */
  dirtyAtInit?: string[];
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
  /** Descriptive spread score (see stats.ts): |best - baseline| relative to
   *  observed run-to-run variation. Not a confidence measure. */
  spread?: number;
}
