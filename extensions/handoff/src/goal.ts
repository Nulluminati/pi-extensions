import type { ExtensionCommandContext } from "pi";
import { promptText } from "../../../lib/input-modal.ts";

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
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Goal is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
          "warning",
        );
      }
      return undefined;
    }
    return trimmed;
  }

  if (!ctx.hasUI) {
    console.warn("Usage: /handoff <goal>");
    return undefined;
  }

  const goal = await promptText(ctx, {
    title: "Handoff",
    placeholder: "What should the new session focus on?",
  });
  if (!goal) return undefined;

  if (goal.length > GOAL_MAX_LENGTH) {
    ctx.ui.notify(
      `Goal is too long (${goal.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
      "warning",
    );
    return undefined;
  }

  return goal;
}
