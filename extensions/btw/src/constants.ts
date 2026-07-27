import { Key } from "@earendil-works/pi-tui";

// --- Constants ---

export const MAX_QUESTION_LENGTH = 2000;

export const THREAD_CUSTOM_TYPE = "btw-thread";

// Focus shortcut. Alt+key is the only modifier combo that `matchesKey`
// matches in legacy terminals (the fallback is `data === "\x1b" + key`).
// Every other modifier (ctrl+key, plain function keys with non-standard
// terminal sequences) is unreliable across terminal emulators.
export const FOCUS_SHORTCUT_PRIMARY = Key.alt("/");

export const FOCUS_SHORTCUT_FALLBACK = Key.ctrlAlt("w");

// Escape sequences that deliver alt+/ across terminals. Alacritty with
// the Kitty keyboard protocol enabled sends the CSI-u form; legacy xterm
// sends ESC + key. We intercept ALL of these in the overlay's handleInput
// so the toggle works regardless of which one the terminal emits.
const ALT_SLASH_SEQUENCES = [
  "\x1b/", // legacy: ESC + /
  "\x1b[47;2u", // Kitty CSI-u: alt + slash (codepoint 47, modifier 2)
  "\x1b[47;3u", // Kitty CSI-u: ctrl+alt + slash (some terminals report both)
  "\x1b[27;2;47;47~", // modify-other-keys: alt + slash
];

export function isFocusShortcut(data: string): boolean {
  return (
    ALT_SLASH_SEQUENCES.includes(data) ||
    data === FOCUS_SHORTCUT_PRIMARY ||
    data === FOCUS_SHORTCUT_FALLBACK
  );
}

export const SIDE_GUIDANCE =
  "You are a side-channel agent: a parallel coding assistant that lives in a small overlay window while the user's main agent works on a separate task. Treat any main-session messages as background only. Focus on the user's side question. Be concise.";

export const SUMMARIZE_GUIDANCE =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";
