import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOCUS_DISABLE, FOCUS_ENABLE, FOCUS_IN_SEQ, FOCUS_OUT_SEQ } from "./constants.ts";
import { handleFocusIn, handleFocusOut } from "./engine.ts";
import { getState } from "./state.ts";

// --- Focus reporting helpers ---

export function attachFocusReporting(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (state.focusEnabled || pi.getFlag("recap-disable-focus") || !ctx.hasUI) return;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  try {
    process.stdout.write(FOCUS_ENABLE);
  } catch {
    return;
  }

  const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
  let buf = "";

  const listener = (chunk: Buffer) => {
    try {
      buf += chunk.toString("binary");
      let i = 0;
      while (i + MAX_SEQ <= buf.length) {
        if (buf.startsWith(FOCUS_IN_SEQ, i)) {
          handleFocusIn(pi, ctx);
          i += FOCUS_IN_SEQ.length;
        } else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
          handleFocusOut(pi, ctx);
          i += FOCUS_OUT_SEQ.length;
        } else {
          i++;
        }
      }
      buf = buf.slice(i);
      if (buf.length > 64) buf = buf.slice(-(MAX_SEQ - 1));
    } catch {
      /* best-effort */
    }
  };

  process.stdin.on("data", listener);
  state.focusListener = listener;
  state.focusEnabled = true;
}

export function detachFocusReporting(pi: ExtensionAPI) {
  const state = getState(pi);
  if (state.focusListener) {
    try {
      process.stdin.off("data", state.focusListener);
    } catch {
      /* noop */
    }
    state.focusListener = undefined;
  }
  if (state.focusEnabled) {
    try {
      process.stdout.write(FOCUS_DISABLE);
    } catch {
      /* noop */
    }
    state.focusEnabled = false;
  }
  state.focusedOutAt = undefined;
  state.focusDraftAfterAgent = false;
  state.pendingRecap = undefined;
}
