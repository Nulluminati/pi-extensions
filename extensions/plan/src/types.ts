/** Shared types for the plan extension. Types live in lib/plan-state.ts
 * (shared with the agents extension); this module re-exports them so
 * plan/src modules keep importing from here. */

export type { Plan, PlanMode, PlanState } from "../../../lib/plan-state.ts";
