// Shared limits, status keys, and visual constants for Goal.

// --- Constants ---

// Status-bar indicator: a Nerd Font checkered-flag icon in a distinct hue with
// a greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf023c);

// nf-md-flag-checkered
export const ICON_COLOR = "mdHeading";

export const TEXT_COLOR = "muted";

export const GOAL_MAX_LENGTH = 4000;

export const STATUS_KEY = "goal";

// Event bus topic for goal state changes, consumed by the status-bar extension
// ("Goal" badge in the editor frame while a goal is running). Payload:
// { status: "active" | "paused" | "complete" | null }.
export const STATE_EVENT = "goal:state-change";

export const COMPLETION_STATUS_DURATION = 8000;

// Default cap on automatic continuations; 0 (set via --iterations 0) means
// unlimited. Guard against runaway goal loops alongside the no-tool guard.
export const DEFAULT_MAX_ITERATIONS = 25;

// Pause the goal after this many consecutive continuation turns that produced
// no tool calls — the model is churning, not working.
export const NO_TOOL_TURN_LIMIT = 3;

// customType of the per-turn goal reminder message injected before each agent
// run and stripped from history by the context event handler.
export const GOAL_CONTEXT_TYPE = "goal-context";
