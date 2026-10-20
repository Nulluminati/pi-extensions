/**
 * Session Recap Extension
 *
 * Shows a one-line recap above the editor when you refocus a Pi session
 * or after idle time, so you can re-enter flow without re-reading scrollback.
 *
 * Triggers:
 *   1. Terminal focus reporting (DECSET ?1004) — drafts a recap on focus-out,
 *      reveals it on focus-in after min duration.
 *   2. Idle fallback — generates a recap N seconds after turn_end.
 *   3. /resume or /fork — recap where the prior session left off.
 *
 * Flags:
 *   --recap-idle-seconds <n>      Idle time before recap (default 45)
 *   --recap-focus-min-seconds <n> Min focus-out duration (default 3)
 *   --recap-disable-focus         Disable focus reporting
 *   --recap-during-active         Allow recaps during active agent turn
 *   --recap-disable               Disable entirely
 *
 * Command:
 *   /recap                        Force-generate a recap now
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FOCUS_MIN_SECONDS,
  DEFAULT_IDLE_SECONDS,
  RESUME_RECAP_DELAY_MS,
} from "./src/constants.ts";
import {
  generateAndShow,
  maybeGenerateDeferredFocusRecap,
  scheduleIdleRecap,
} from "./src/engine.ts";
import { attachFocusReporting, detachFocusReporting } from "./src/focus.ts";
import { getState, resetState } from "./src/state.ts";
import { clearRecap } from "./src/widget.ts";

// --- Extension ---

export default async function sessionRecapExtension(pi: ExtensionAPI) {
  pi.registerFlag("recap-idle-seconds", {
    description: "Seconds after turn_end before the session recap is generated",
    type: "string",
    default: String(DEFAULT_IDLE_SECONDS),
  });
  pi.registerFlag("recap-focus-min-seconds", {
    description: "Minimum focus-out duration (seconds) before showing a recap on refocus",
    type: "string",
    default: String(DEFAULT_FOCUS_MIN_SECONDS),
  });
  pi.registerFlag("recap-disable-focus", {
    description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-during-active", {
    description: "Allow focus-triggered recaps while an agent turn is still running",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-disable", {
    description: "Disable the automatic session recap",
    type: "boolean",
    default: false,
  });
  // --- Event handlers ---

  pi.on("turn_end", async (_event, ctx) => {
    const state = getState(pi);
    state.lastDraftedLeafId = undefined;
    scheduleIdleRecap(pi, ctx);
    maybeGenerateDeferredFocusRecap(pi, ctx);
  });

  pi.on("turn_start", async () => {
    const state = getState(pi);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
  });

  pi.on("input", async (_event, ctx) => {
    const state = getState(pi);
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.focusDraftAfterAgent = false;
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    clearRecap(pi, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = true;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      state.activeReason = undefined;
    }
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    clearRecap(pi, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = false;
    maybeGenerateDeferredFocusRecap(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = getState(pi);
    state.agentActive = false;
    state.focusDraftAfterAgent = false;
    resetState(state);
    detachFocusReporting(pi);
    clearRecap(pi, ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const state = getState(pi);
    resetState(state);
    attachFocusReporting(pi, ctx);
    if (pi.getFlag("recap-disable") || !ctx.hasUI) return;
    if (event.reason === "resume" || event.reason === "fork") {
      state.resumeTimer = setTimeout(() => {
        state.resumeTimer = undefined;
        void generateAndShow(pi, ctx, { reason: "resume" });
      }, RESUME_RECAP_DELAY_MS);
    }
  });

  // --- Manual command ---

  pi.registerCommand("recap", {
    description: "Generate a one-line recap of recent session activity",
    handler: async (_args, ctx) => {
      await generateAndShow(pi, ctx, { reason: "manual" });
    },
  });
}
