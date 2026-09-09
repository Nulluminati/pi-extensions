/** Keys, tool sets, and entry/message types for the plan extension. */

export const ENTRY_TYPE = "plan-state";

/** Custom messages injected per turn (filtered from context between turns). */
export const PLAN_CONTEXT_TYPE = "plan-context";
export const EXECUTION_CONTEXT_TYPE = "plan-execution-context";
export const PLAN_COMPLETE_TYPE = "plan-complete";

export const PLAN_SUBMIT_TOOL = "plan_submit";

/** Built-in tools that mutate files; blocked outright in plan mode. */
export const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Extension tools with mutation channels that must not run while planning:
 * `background` spawns arbitrary shell commands (bypassing the bash gate),
 * autoresearch performs git commits, and mission reconcile runs arbitrary
 * verification commands. Blocked by name alongside the built-ins.
 */
export const PLAN_BLOCKED_EXTENSION_TOOLS = new Set(["background", "autoresearch", "mission"]);

/**
 * Event emitted on pi.events when plan mode changes. The status-bar extension
 * subscribes to tint the editor frame while planning; the string is mirrored
 * in status-bar's own constants so both extensions stay self-contained.
 */
export const PLAN_MODE_EVENT = "plan:mode-change";
