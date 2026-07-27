import type { ExtensionAPI, ExtensionContext } from "pi";
import {
  DEFAULT_FOCUS_MIN_SECONDS,
  DEFAULT_IDLE_SECONDS,
  ICON_COLOR,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
} from "./constants.ts";
import { generateRecap } from "./generate.ts";
import { getState } from "./state.ts";
import { buildRecentTranscript, hasMeaningfulActivity } from "./transcript.ts";
import type { Entry, RecapReason } from "./types.ts";
import { showRecap } from "./widget.ts";

export function handleFocusOut(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  state.focusedOutAt = Date.now();
  if (pi.getFlag("recap-disable") || state.activeController) return;

  if (state.agentActive && !pi.getFlag("recap-during-active")) {
    state.focusDraftAfterAgent = true;
    return;
  }

  const leaf = ctx.sessionManager.getLeafId();
  if (state.lastDraftedLeafId && leaf === state.lastDraftedLeafId) return;

  const entries = ctx.sessionManager.getBranch() as Entry[];
  if (!hasMeaningfulActivity(entries)) return;
  void generateAndShow(pi, ctx, { reason: "focus" });
}

export function handleFocusIn(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  const outAt = state.focusedOutAt;
  state.focusedOutAt = undefined;
  state.focusDraftAfterAgent = false;
  if (outAt === undefined) return;

  const duration = Date.now() - outAt;
  const minMs = Number(pi.getFlag("recap-focus-min-seconds") ?? DEFAULT_FOCUS_MIN_SECONDS) * 1000;
  if (duration < minMs) {
    state.pendingRecap = undefined;
    state.lastDraftedLeafId = undefined;
    if (state.activeReason === "focus") {
      if (state.activeController) {
        state.activeController.abort();
        state.activeController = undefined;
        state.activeReason = undefined;
      }
    }
    return;
  }

  if (state.pendingRecap) {
    const recap = state.pendingRecap;
    state.pendingRecap = undefined;
    showRecap(pi, ctx, recap);
  }
}

export function maybeGenerateDeferredFocusRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (!state.focusDraftAfterAgent) return;
  if (state.focusedOutAt === undefined) return;
  if (state.agentActive) return;
  state.focusDraftAfterAgent = false;
  void generateAndShow(pi, ctx, { reason: "focus" });
}

// --- Core recap generation ---

export async function generateAndShow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { reason: RecapReason },
) {
  const state = getState(pi);
  const entries = ctx.sessionManager.getBranch() as Entry[];
  if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

  const transcript = buildRecentTranscript(entries, opts.reason !== "resume");
  if (!transcript.trim()) return;

  const startLeaf = ctx.sessionManager.getLeafId();

  // Cancel any prior request
  if (state.activeController) {
    state.activeController.abort();
    state.activeController = undefined;
    state.activeReason = undefined;
  }

  const controller = new AbortController();
  state.activeController = controller;
  state.activeReason = opts.reason;

  const showStatus = opts.reason !== "resume" && opts.reason !== "focus";
  if (showStatus && ctx.hasUI) {
    ctx.ui.setStatus(
      STATUS_KEY,
      `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "drafting recap…")}`,
    );
  }

  try {
    const recap = await generateRecap(transcript, ctx, controller.signal);
    if (!recap || controller.signal.aborted) return;
    if (ctx.sessionManager.getLeafId() !== startLeaf) return;

    state.lastDraftedLeafId = startLeaf;
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }

    if (opts.reason === "focus") {
      if (state.focusedOutAt === undefined) showRecap(pi, ctx, recap);
      else state.pendingRecap = recap;
    } else {
      showRecap(pi, ctx, recap);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      if (opts.reason === "manual" && ctx.hasUI) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      } else {
        console.error("[session-recap] failed:", err);
      }
    }
  } finally {
    if (state.activeController === controller) {
      state.activeController = undefined;
      state.activeReason = undefined;
      if (showStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function scheduleIdleRecap(pi: ExtensionAPI, ctx: ExtensionContext) {
  const state = getState(pi);
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  if (pi.getFlag("recap-disable") || !ctx.hasUI) return;

  const seconds = Number(pi.getFlag("recap-idle-seconds") ?? DEFAULT_IDLE_SECONDS);
  const ms = Math.max(5, Number.isFinite(seconds) ? seconds : DEFAULT_IDLE_SECONDS) * 1000;

  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    void generateAndShow(pi, ctx, { reason: "idle" });
  }, ms);
}
