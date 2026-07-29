// Status-bar indicator: a Nerd Font swap icon in a distinct accent hue with a
// greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf04e1); // nf-md-swap-horizontal
export const ICON_COLOR = "accent";
export const TEXT_COLOR = "muted";
export const STATUS_KEY = "handoff";
