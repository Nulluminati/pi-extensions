import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const GOAL_MAX_LENGTH = 4000;

export function formatGoalForSessionName(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "Handoff session";
  // Capitalize first letter, keep it short.
  const headline = trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
  return headline.length > 60 ? `${headline.slice(0, 59)}…` : headline;
}

/**
 * Resolve the optional handoff goal from the command args. Returns an empty
 * string when no goal is given (the summary is then drafted from the
 * transcript alone), or undefined when the goal is too long.
 */
export async function resolveGoal(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const trimmed = args.trim();
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
