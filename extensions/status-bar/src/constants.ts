// --- Constants ---

// Self-indicator icon: a Nerd Font bottom-dock glyph in the "enabled" hue with
// a greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf10a9);

// nf-md-dock-bottom
export const ICON_COLOR = "success";

export const TEXT_COLOR = "muted";

export const STATUS_KEY = "status-bar";

export const BAR_SEGMENTS = 10;

export const MAX_TOOL_NAME = 18;

// Nerd Font icons (Starship-inspired). The two Material Design glyphs live
// in the Private Use Area, so they're built from codepoints to survive any
// transport that would strip an invisible literal to a space.
export const ICON_CWD = String.fromCodePoint(0xf0770);

// nf-md-folder
export const ICON_GIT = String.fromCodePoint(0xf418);

// nf-md-git
export const ICON_THINKING = String.fromCodePoint(0xf09d1);

// nf-md-brain

// Lightning bolt marks the Neuralwatt flex pricing tier, shown next to the
// thinking level in the editor meta line when the selected model is flex-capable.
export const ICON_FLEX = "⚡";
export const FLEX_ON_COLOR = "success"; // green — the discounted tier is active
export const FLEX_OFF_COLOR = "dim";
export const ICON_TURN = "↻";

export const ICON_TOOL_ACTIVE = "⚙";

export const ICON_TOOL_DONE = "✓";

// Git status indicators (Starship).
export const ICON_AHEAD = "↑";

export const ICON_BEHIND = "↓";

export const ICON_DIVERGED = "⇕";

export const ICON_CONFLICTED = "=";

export const ICON_UNTRACKED = "?";

export const ICON_STASHED = "$";

export const ICON_MODIFIED = "!";

export const ICON_STAGED = "+";

export const ICON_RENAMED = "»";

export const ICON_DELETED = "✘";

export const ICON_TYPECHANGED = "T";

export const THINKING_THEME_COLOR: Record<string, string> = {
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
};

// Distinct hues per token indicator, drawn from the theme's harmonized
// palette (the same family as the model/directory colors) so they match the
// terminal rather than clashing VS Code syntax hexes or raw semantic colors.
export const TOKEN_COLORS = {
  input: "accent", // ↑ teal — matches the model
  output: "mdHeading", // ↓ gold
  cacheRead: "mdLink", // ↗ blue — matches the directory
  cacheWrite: "thinkingHigh", // ↘ purple
} as const;

// Padding inside the input-box modal frame, matching the voice/handoff
// modals so the prompt box reads as the same chrome.
export const MODAL_PADDING_X = 2;

export const MODAL_PADDING_Y = 1;

// Gap between pre-colored title segments (model, thinking, small model) in the
// input-box top border.
export const EDITOR_META_SEPARATOR = "  ";

/**
 * Status key the small-model extension publishes under. Defined locally (not
 * imported) so the status-bar extension stays self-contained; the small-model
 * extension owns the contract and uses the same string. Suppressed from footer
 * line 2 because the small model is shown in the editor meta line instead.
 */
export const SMALL_MODEL_STATUS_KEY = "small-model";

/**
 * Event the Neuralwatt extension emits on pi.events to publish flex state for
 * the current model. Defined here (not imported) so the status-bar extension
 * stays self-contained; the Neuralwatt extension owns the contract and emits
 * the same string.
 */
export const FLEX_EVENT = "neuralwatt:flex-change";

/**
 * Event the plan extension emits on pi.events when plan mode changes. Used to
 * tint the editor frame while planning. Defined here (not imported) so the
 * status-bar extension stays self-contained; the plan extension owns the
 * contract and emits the same string.
 */
export const PLAN_MODE_EVENT = "plan:mode-change";
