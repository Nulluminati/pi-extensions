/**
 * Plan state persistence and reconstruction. The implementation lives in
 * lib/plan-state.ts (shared with the agents extension); this module
 * re-exports it so plan/src modules and tests keep importing from here.
 * Step completion lives in lib/todos.ts — an approved plan becomes the todo
 * list.
 */

export {
  completedStepCount,
  findPlanStateEntry,
  isPlanComplete,
  isPlanModeActive,
  reconstructState,
} from "../../../lib/plan-state.ts";
