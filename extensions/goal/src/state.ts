import type { ExtensionContext } from "pi";
import type { GoalState } from "./types.ts";

// --- Utilities ---

export function generateGoalId(): string {
  return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- State management ---

const VALID_STATUSES = new Set(["active", "paused", "budget", "complete"]);

/**
 * Persisted shape. "budget" is a legacy status from before the token budget
 * was removed; it is normalized to "paused" on reconstruction.
 */
type PersistedGoalState = Omit<GoalState, "status"> & {
  status: "active" | "paused" | "complete" | "budget";
};

function isGoal(value: unknown): value is PersistedGoalState {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<GoalState>;
  return (
    typeof goal.id === "string" &&
    typeof goal.objective === "string" &&
    VALID_STATUSES.has(String(goal.status)) &&
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
      const data = entry.data as { goal?: PersistedGoalState | null } | null;
      if (!isGoal(data?.goal) || data.goal.status === "complete") return null;
      const { status, ...rest } = data.goal;
      return { ...rest, status: status === "budget" ? "paused" : status };
    }
  }
  return null;
}
