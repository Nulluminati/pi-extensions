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

// Neutral grey used for the polished editor frame. Held constant so the input
// box never tracks the thinking-level border color.
export const EDITOR_FRAME_COLOR = "borderMuted";

export const EDITOR_META_SEPARATOR = "  ";

export const EDITOR_MARKER = Symbol.for("pi-statusbar.editor-factory");
