// Shared status styling and guest workspace constants for Gondolin.

// Status-bar indicator: a Nerd Font cube icon in a distinct hue with a greyed
// label, matching the cross-extension footer convention. The codepoint is
// built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf01a6);

// nf-md-cube
export const ICON_COLOR = "thinkingHigh";

export const TEXT_COLOR = "muted";

export const STATUS_KEY = "gondolin";

export const GUEST_WORKSPACE = "/workspace";
