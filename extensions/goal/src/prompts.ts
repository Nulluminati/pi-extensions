import type { GoalState } from "./types.ts";

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function goalObjectiveBlock(objective: string): string {
  return `<goal_objective>\n${escapeXmlText(objective)}\n</goal_objective>`;
}

function goalPersistenceRules(goalLabel: string): string {
  return `Keep going until ${goalLabel} is completely resolved end-to-end. Do not redefine ${goalLabel} into a smaller task. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps. Autonomously perform implementation and verification with the available tools when they are needed. Treat the current worktree, command output, tests, and external state as authoritative. If a tool call fails, try reasonable alternatives instead of yielding early. Before reporting the goal complete, audit ${goalLabel} requirement by requirement against the verified current state.`;
}

/**
 * Per-turn goal reminder injected as a tail-position message. Deliberately
 * contains only stable text (objective + rules, no counters): the prompt cache
 * keeps every token before the injection point, and stable bytes let
 * consecutive turns reuse even the injected message itself.
 */
export function buildGoalContextPrompt(goal: GoalState): string {
  return `Active /goal:\n${goalObjectiveBlock(goal.objective)}\n\nGoal-mode rules:\n- Keep going until the active goal is completely resolved end-to-end.\n- Treat the current worktree, command output, tests, and external state as authoritative.\n- Do not redefine the goal into a smaller task; audit every requirement before completion.\n- Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.\n- Autonomously perform implementation and verification with the available tools when they are needed to complete the goal.\n- Persevere through recoverable tool failures by trying reasonable alternatives instead of yielding early.\n- If the goal is not complete at the end of a turn, expect an automatic continuation and keep working from where you left off.`;
}

export function buildStartPrompt(goal: GoalState): string {
  return `Goal mode is active. Complete this goal fully:\n\n${goalObjectiveBlock(goal.objective)}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildResumePrompt(goal: GoalState): string {
  return `The user explicitly resumed the paused /goal. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}\n\n${goalPersistenceRules("this goal")}`;
}

export function buildObjectiveUpdatedPrompt(goal: GoalState): string {
  return `The active /goal objective was updated. Continue working toward this goal:\n\n${goalObjectiveBlock(goal.objective)}\n\n${goalPersistenceRules("the updated goal")}`;
}

export function buildContinuePrompt(goal: GoalState): string {
  const iterLabel = goal.iteration > 99 ? "100+" : String(goal.iteration);
  const guidance = goal.lastEvaluatorReason
    ? `The goal evaluator is not yet satisfied: ${goal.lastEvaluatorReason}\n\n`
    : "";
  return `Continue the active /goal until it is complete:\n\n${goalObjectiveBlock(goal.objective)}\n\n${guidance}This is automatic continuation #${iterLabel}. Current files, command output, tests, and external state are authoritative; re-check them as needed. ${goalPersistenceRules("this goal")}`;
}

// --- Evaluator prompts ---

export const EVALUATOR_SYSTEM_PROMPT =
  "You judge whether a coding-agent goal has been met based only on evidence in the conversation transcript. Respond with ONLY a JSON object and no other text.";

export function buildEvaluatorPrompt(objective: string, transcript: string): string {
  return `Active goal:\n${goalObjectiveBlock(objective)}\n\nRecent conversation evidence:\n<transcript>\n${transcript}\n</transcript>\n\nJudge whether the goal is met, using only what the transcript shows. Tool results and command output in the transcript are the evidence; assistant claims without evidence are not. Respond with exactly one JSON object and nothing else:\n- {"status":"met","reason":"<one line citing the supporting evidence>"}\n- {"status":"not_met","reason":"<one line: what is missing or what to try next>"}\n- {"status":"impossible","reason":"<one line: why the goal can never be satisfied>"}`;
}
