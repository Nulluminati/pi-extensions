/** Prompt and text builders for plan mode. Pure functions. */

import type { Plan } from "./types.ts";

/** Context message injected on every turn while in plan mode. */
export function buildPlanModeContext(): string {
  return `[PLAN MODE ACTIVE]
You are in plan mode: read-only research only. Do not make any changes.

Restrictions:
- The edit and write tools are blocked and cannot modify files.
- Bash is restricted to read-only commands (cat, grep, git log/status/diff, npm view, etc.). Mutating commands are blocked and will fail.
- Worker patch collection is blocked until the plan is approved.

You may delegate bounded research tasks. Planning workers always run in Gondolin with a default-deny, read-only tool set; use workers status to read their reports.

Your job: research the request thoroughly (read relevant files, search, inspect git history), ask clarifying questions if the request is ambiguous, and when you have a complete plan, call the plan_submit tool with a concise title and a numbered list of concrete steps. Do not perform any of the work — only propose it.`;
}

/** Context message injected on every turn while executing an approved plan. */
export function buildExecutionContext(plan: Plan): string {
  const steps = plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  return `[EXECUTING PLAN — full tool access]
Approved plan: ${plan.title}

Steps:
${steps}

Execute the steps in order. The steps are already in the todo list: use the todo tool with action check to mark each item done as you finish it (item numbers are 1-based, matching the displayed list). When every item is checked, summarize what changed.`;
}

/** User message that kicks off execution after approval. */
export function buildKickoffMessage(plan: Plan): string {
  const steps = plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  return `Execute the approved plan: ${plan.title}

Steps:
${steps}

I've added these steps to the todo list. Use the todo tool (action check) to mark each item done as you finish it. When every item is checked, summarize what changed.`;
}

/** Plain-text rendering of a plan, used for the approval modal. */
export function formatPlanText(plan: Plan): string {
  const steps = plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  const notes = plan.notes ? `\n\nNotes: ${plan.notes}` : "";
  return `Title: ${plan.title}\n\nSteps:\n${steps}${notes}`;
}

/** Transcript message shown when execution finishes. */
export function buildPlanCompleteMessage(plan: Plan): string {
  const completed = plan.steps.map((step) => `~~${step}~~`).join("\n");
  return `**Plan complete!** ${plan.title}\n\n${completed}`;
}
