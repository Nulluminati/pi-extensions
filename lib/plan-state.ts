/**
 * Shared plan-state parsing for Pi extensions.
 *
 * Owns the shape and validation of the persisted "plan-state" session entry.
 * The plan extension appends these entries and reconstructs its own state
 * through the re-exports in extensions/plan/src/state.ts; other extensions
 * (agents) read only whether plan mode is active, without depending on the
 * plan extension, so each keeps working when the other is not loaded. Step
 * completion is measured against the shared todo list (lib/todos.ts) — an
 * approved plan becomes the todo list.
 */

import type { TodoItem } from "./todos.ts";

/** Custom entry type the plan extension persists its state under. */
export const PLAN_STATE_ENTRY_TYPE = "plan-state";

export type PlanMode = "off" | "plan" | "executing" | "readonly";

export interface Plan {
  title: string;
  steps: string[];
  notes?: string;
}

export interface PlanState {
  mode: PlanMode;
  plan: Plan | null;
  toolsBeforePlan: string[] | undefined;
}

interface CustomEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Returns the latest persisted plan-state entry, if any. Entries append
 * chronologically, so the last match carries the newest state. */
export function findPlanStateEntry(entries: unknown[]): CustomEntry | undefined {
  let found: CustomEntry | undefined;
  for (const entry of entries as CustomEntry[]) {
    if (entry?.type === "custom" && entry.customType === PLAN_STATE_ENTRY_TYPE) {
      found = entry;
    }
  }
  return found;
}

function isValidPlan(value: unknown): value is Plan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Plan;
  return (
    typeof plan.title === "string" &&
    Array.isArray(plan.steps) &&
    plan.steps.length > 0 &&
    plan.steps.every((step) => typeof step === "string")
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
  if (
    candidate.mode !== "off" &&
    candidate.mode !== "plan" &&
    candidate.mode !== "executing" &&
    candidate.mode !== "readonly"
  ) {
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

/**
 * True when the plan's steps are all completed in the todo list. Only the
 * first `steps.length` items count — the plan's own steps — so extra items
 * the agent adds mid-execution do not block completion.
 */
export function isPlanComplete(plan: Plan, items: TodoItem[]): boolean {
  const ownSteps = items.slice(0, plan.steps.length);
  return ownSteps.length === plan.steps.length && ownSteps.every((item) => item.completed);
}

/** Completed step count for status display. */
export function completedStepCount(plan: Plan, items: TodoItem[]): number {
  return items.slice(0, plan.steps.length).filter((item) => item.completed).length;
}

/**
 * True when the session owning these entries is currently in plan mode.
 * Used by the agents extension: a delegate call made while planning must
 * spawn read-only workers, or the worker would bypass plan mode's
 * restrictions on the parent.
 */
export function isPlanModeActive(entries: unknown[]): boolean {
  return reconstructState(entries)?.mode === "plan";
}
