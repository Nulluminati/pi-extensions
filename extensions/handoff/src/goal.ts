import type { ExtensionCommandContext } from "pi";
import { notify } from "./ui.ts";

const GOAL_MAX_LENGTH = 4000;

export function formatGoalForSessionName(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "Handoff session";
  // Capitalize first letter, keep it short.
  const headline = trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
  return headline.length > 60 ? `${headline.slice(0, 59)}…` : headline;
}

export async function resolveGoal(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) {
    if (trimmed.length > GOAL_MAX_LENGTH) {
      notify(
        ctx,
        `Goal is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
        "warning",
      );
      return undefined;
    }
    return trimmed;
  }

  if (!ctx.hasUI) {
    notify(ctx, "Usage: /handoff <goal>", "warning");
    return undefined;
  }

  const goal = await ctx.ui.input("Handoff goal", "What should the new session focus on?");
  if (!goal) return undefined;

  if (goal.length > GOAL_MAX_LENGTH) {
    notify(
      ctx,
      `Goal is too long (${goal.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
      "warning",
    );
    return undefined;
  }

  return goal;
}
