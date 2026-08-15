/** Keys, tool sets, and entry/message types for the plan extension. */

export const STATUS_KEY = "plan";
export const WIDGET_KEY = "plan-todos";
export const ENTRY_TYPE = "plan-state";

/** Custom messages injected per turn (filtered from context between turns). */
export const PLAN_CONTEXT_TYPE = "plan-context";
export const EXECUTION_CONTEXT_TYPE = "plan-execution-context";
export const PLAN_COMPLETE_TYPE = "plan-complete";

export const PLAN_SUBMIT_TOOL = "plan_submit";

/** Built-in tools that mutate files; blocked outright in plan mode. */
export const MUTATING_TOOLS = new Set(["edit", "write"]);
