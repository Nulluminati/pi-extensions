// Shared state contract for the active goal lifecycle.

// --- Types ---

export interface GoalState {
  id: string;
  objective: string;
  status: "active" | "paused" | "budget" | "complete";
  startTime: number;
  elapsedMs: number;
  iteration: number;
  tokensUsed: number;
  baselineTokens: number;
  tokenBudget?: number;
  lastTurnTimestamp?: number;
}
