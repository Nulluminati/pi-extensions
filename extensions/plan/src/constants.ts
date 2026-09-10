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
 * Plan mode is DEFAULT-DENY: the active tool set while planning is the
 * intersection of the session's tools with this allowlist (plus plan_submit).
 * Anything not listed — including tools from extensions added later — is
 * unavailable while planning, so new mutation channels fail closed.
 * `bash` stays active but is gated by the read-only command allowlist.
 */
export const PLAN_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "todo",
  "ask-user",
  "messenger",
  "code-search",
  "context7",
  "web-search",
]);

/**
 * Event emitted on pi.events when plan mode changes. The status-bar extension
 * subscribes to tint the editor frame while planning; the string is mirrored
 * in status-bar's own constants so both extensions stay self-contained.
 */
export const PLAN_MODE_EVENT = "plan:mode-change";
