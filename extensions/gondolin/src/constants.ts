// Shared status styling and guest workspace constants for Gondolin.

// Status-bar indicator: a Nerd Font cube icon in a distinct hue with a greyed
// label, matching the cross-extension footer convention. The codepoint is
// built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf01a6);

// nf-md-cube
export const ICON_COLOR = "thinkingHigh";

export const TEXT_COLOR = "muted";

export const STATUS_KEY = "gondolin";

// Event bus topic for VM state changes, consumed by the status-bar extension
// (footer line 1 workspace segment). Payload: { state: "starting" | "ready" |
// "stopping" | "stopped", vmId?: string }.
export const VM_EVENT = "gondolin:vm-state";

export const GUEST_WORKSPACE = "/workspace";
