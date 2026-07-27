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

export const COMPLETION_STATUS_DURATION = 8000;
