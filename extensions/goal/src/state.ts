import type { ExtensionContext } from "pi";
import type { GoalState } from "./types.ts";

// --- Utilities ---

export function generateGoalId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- State management ---

function isGoal(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<GoalState>;
  return (
    typeof goal.id === "string" &&
    typeof goal.objective === "string" &&
    ["active", "paused", "budget", "complete"].includes(String(goal.status)) &&
    typeof goal.startTime === "number" &&
    typeof goal.elapsedMs === "number" &&
    typeof goal.iteration === "number" &&
    typeof goal.tokensUsed === "number" &&
    typeof goal.baselineTokens === "number"
  );
}

export function reconstructState(ctx: ExtensionContext): GoalState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === "goal-state") {
      const data = entry.data as { goal?: GoalState | null } | null;
      return isGoal(data?.goal) && data.goal.status !== "complete" ? data.goal : null;
    }
  }
  return null;
}
