import type { ExtensionContext } from "pi";

// --- Constants ---

// Status-bar indicator: a Nerd Font swap icon in a distinct accent hue with a
// greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf04e1); // nf-md-swap-horizontal
export const ICON_COLOR = "accent";
export const TEXT_COLOR = "muted";
export const STATUS_KEY = "handoff";

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  } else if (type === "error") {
    console.error(message);
  } else if (type === "warning") {
    console.warn(message);
  } else {
    console.log(message);
  }
}
