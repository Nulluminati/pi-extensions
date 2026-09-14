/** Keys, tool sets, and entry/message types for the plan extension. */

// The session entry type is owned by lib/plan-state.ts (shared with agents);
// this re-export keeps plan's own import surface unchanged.
export { PLAN_STATE_ENTRY_TYPE as ENTRY_TYPE } from "../../../lib/plan-state.ts";

/** Custom messages injected per turn (filtered from context between turns). */
export const PLAN_CONTEXT_TYPE = "plan-context";
export const EXECUTION_CONTEXT_TYPE = "plan-execution-context";
export const PLAN_COMPLETE_TYPE = "plan-complete";

export const PLAN_SUBMIT_TOOL = "plan_submit";

/** Built-in tools that mutate files; blocked outright in plan mode. */
export const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Research tools available to both the planning session and its read-only
 * workers. Anything not listed is unavailable in a worker, so configured
 * extension tools cannot create a new mutation channel. `bash` stays active
 * but is gated by the read-only command allowlist.
 */
export const PLAN_WORKER_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "todo",
  "ask_user",
  "messenger",
  "code_search",
  "context7_resolve_library_id",
  "context7_get_library_docs",
  "context7_get_cached_doc_raw",
  "web_search",
  "web_fetch",
]);

/**
 * Plan mode is DEFAULT-DENY: it keeps research tools plus worker orchestration.
 * The `workers` tool is gated separately so status/list/cancel remain available
 * while patch collection, which can modify the workspace, is blocked.
 */
export const PLAN_ALLOWED_TOOLS = new Set([...PLAN_WORKER_ALLOWED_TOOLS, "delegate", "workers"]);

/**
 * Event emitted on pi.events when plan mode changes. The status-bar extension
 * subscribes to tint the editor frame while planning; the string is mirrored
 * in status-bar's own constants so both extensions stay self-contained.
 */
export const PLAN_MODE_EVENT = "plan:mode-change";
