/**
 * Plan state persistence, reconstruction, and step tracking. Pure functions
 * over session entries; the composition root owns transitions and pi calls.
 */

import { ENTRY_TYPE } from "./constants.ts";
import type { Plan, PlanState, PlanStep } from "./types.ts";

interface CustomEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Returns the persisted plan-state entry, if any. */
export function findPlanStateEntry(entries: unknown[]): CustomEntry | undefined {
  for (const entry of entries as CustomEntry[]) {
    if (entry?.type === "custom" && entry.customType === ENTRY_TYPE) {
      return entry;
    }
  }
  return undefined;
}

function isValidStep(value: unknown): value is PlanStep {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PlanStep).description === "string" &&
    typeof (value as PlanStep).completed === "boolean"
  );
}

function isValidPlan(value: unknown): value is Plan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Plan;
  return (
    typeof plan.title === "string" &&
    Array.isArray(plan.steps) &&
    plan.steps.length > 0 &&
    plan.steps.every(isValidStep)
  );
}

/**
 * Reconstructs plan state from session entries. Returns undefined when no
 * valid state is persisted, so callers can fall back to a fresh state.
 */
export function reconstructState(entries: unknown[]): PlanState | undefined {
  const entry = findPlanStateEntry(entries);
  if (!entry) return undefined;

  const data = entry.data as { state?: unknown } | undefined;
  const state = data?.state;
  if (typeof state !== "object" || state === null) return undefined;

  const candidate = state as PlanState;
  if (candidate.mode !== "off" && candidate.mode !== "plan" && candidate.mode !== "executing") {
    return undefined;
  }
  if (candidate.plan !== null && !isValidPlan(candidate.plan)) return undefined;
  if (candidate.toolsBeforePlan !== undefined && !Array.isArray(candidate.toolsBeforePlan)) {
    return undefined;
  }

  return {
    mode: candidate.mode,
    plan: candidate.plan,
    toolsBeforePlan: candidate.toolsBeforePlan,
  };
}

/** Extracts [DONE:n] markers from assistant text. */
export function extractDoneSteps(text: string): number[] {
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/** Marks steps completed from [DONE:n] markers; returns how many matched. */
export function markCompletedSteps(text: string, steps: PlanStep[]): number {
  const doneSteps = extractDoneSteps(text);
  let matched = 0;
  for (const step of doneSteps) {
    const item = steps[step - 1];
    if (item && !item.completed) {
      item.completed = true;
      matched++;
    }
  }
  return matched;
}

/** True when every step of the plan is completed. */
export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.length > 0 && plan.steps.every((step) => step.completed);
}

/** Concatenated text of an assistant message, for [DONE:n] scanning. */
export function getAssistantText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } => {
        return (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        );
      })
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
