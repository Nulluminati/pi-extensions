import { formatTokens } from "./formatting.ts";
import type { GoalState } from "./types.ts";

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function goalObjectiveBlock(objective: string): string {
  return `<goal_objective>\n${escapeXmlText(objective)}\n</goal_objective>`;
}

function goalPersistenceRules(goalLabel: string): string {
  return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before calling goal_complete, audit ${goalLabel} requirement by requirement against the verified current state. Only call the goal_complete tool after ${goalLabel} is fully complete and verified.`;
}

export function buildGoalSystemPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\n- Respect the goal token budget (${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used).`;
  return `Active /goal:\n${goalObjectiveBlock(goal.objective)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.\n- Only call the goal_complete tool after the goal is fully complete and verified.${budgetLine}`;
}

export function buildStartPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined ? "" : `\nToken budget: ${formatTokens(goal.tokenBudget)}.`;
  return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildResumePrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildObjectiveUpdatedPrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\n${goalPersistenceRules("the updated goal")}`;
}

export function buildContinuePrompt(goal: GoalState): string {
  const budgetLine =
    goal.tokenBudget === undefined
      ? ""
      : `\nToken budget: ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)} used.`;
  const iterLabel = goal.iteration > 99 ? "100+" : String(goal.iteration);
  return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal.objective)}${budgetLine}\n\nThis is automatic continuation #${iterLabel}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}`;
}
