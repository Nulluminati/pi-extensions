// Shared state contract for the active goal lifecycle.

// --- Types ---

export interface GoalState {
  id: string;
  objective: string;
  status: "active" | "paused" | "complete";
  startTime: number;
  elapsedMs: number;
  iteration: number;
  tokensUsed: number;
  baselineTokens: number;
  /**
   * Maximum number of automatic continuations before the goal pauses.
   * 0 means unlimited; undefined falls back to the default cap.
   */
  maxIterations?: number;
  /** Most recent evaluator verdict reason, shown in /goal:status. */
  lastEvaluatorReason?: string;
  /** Consecutive continuation turns that produced no tool calls. */
  consecutiveNoToolTurns?: number;
  lastTurnTimestamp?: number;
}
