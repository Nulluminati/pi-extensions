// --- Constants ---

export const WIDGET_KEY = "session-recap";

export const DEFAULT_IDLE_SECONDS = 45;

export const DEFAULT_FOCUS_MIN_SECONDS = 3;

export const RESUME_RECAP_DELAY_MS = 300;

export const AUTO_DISMISS_MS = 120_000;

/** Character budget for the transcript embedded in the recap prompt. */
export const PROMPT_TRANSCRIPT_MAX_CHARS = 12_000;

/** Wire name of the recap widget event published on the pi.events bus
 * ("recap:changed") whenever the recap widget appears or clears. Sibling
 * widgets — todos — subscribe to re-insert themselves below the recap.
 * Keep the literal in sync with extensions/todos/todos.ts. */
export const RECAP_CHANGED_EVENT = "recap:changed";

// DECSET 1004 focus reporting sequences
export const FOCUS_ENABLE = "\x1b[?1004h";

export const FOCUS_DISABLE = "\x1b[?1004l";

export const FOCUS_IN_SEQ = "\x1b[I";

export const FOCUS_OUT_SEQ = "\x1b[O";
