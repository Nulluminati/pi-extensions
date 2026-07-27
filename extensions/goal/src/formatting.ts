import type { GoalState } from "./types.ts";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

export function getElapsedMs(state: GoalState): number {
  if (state.status !== "active") return state.elapsedMs;
  const lastTs = state.lastTurnTimestamp ?? state.startTime;
  return state.elapsedMs + Math.max(0, Date.now() - lastTs);
}

export function buildStatusLine(state: GoalState): string {
  if (state.status === "complete") return "complete";
  if (state.status === "paused") return "paused";
  if (state.status === "budget") {
    const b = state.tokenBudget;
    if (b === undefined) return "budget";
    return `budget ${formatTokens(state.tokensUsed)}/${formatTokens(b)}`;
  }
  if (state.tokenBudget) {
    return `active ${formatTokens(state.tokensUsed)}/${formatTokens(state.tokenBudget)}`;
  }
  return `active ${formatElapsed(getElapsedMs(state))}`;
}
