/**
 * BTW — "By the Way" Side Channel
 *
 * A parallel side conversation in a top-centered overlay window.
 * The user can ask side questions while the main agent is busy, then
 * hand results back when ready. The side thread is hidden from the
 * main agent's context by default.
 *
 * Architecture follows the platform's component model: the overlay is a
 * `Container` whose rows are wrapped with `renderModalFrame`, and the
 * composer is the platform's `Input` widget. The TUI positions the
 * overlay and clips anything that overflows; we just render the right rows
 * in the right order.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { confirmModal } from "../../lib/input-modal.ts";
import { requestSideTurn } from "./src/agent.ts";
import {
  FOCUS_SHORTCUT_FALLBACK,
  FOCUS_SHORTCUT_PRIMARY,
  MAX_QUESTION_LENGTH,
  THREAD_CUSTOM_TYPE,
} from "./src/constants.ts";
import { buildHandoffContent, runSummarize } from "./src/handoff.ts";
import { resolveSmallModelDisplay } from "./src/model.ts";
import { openOverlay } from "./src/overlay.ts";
import {
  appendResetMarker,
  emptyThread,
  persistThread,
  reconstructThreadState,
  statusToText,
} from "./src/thread.ts";
import { rebuildTranscriptFromThread, requestRender } from "./src/transcript.ts";
import type { BtwLiveState, BtwMode } from "./src/types.ts";

// --- Extension ---

export default async function btwExtension(pi: ExtensionAPI) {
  const state: BtwLiveState = {
    thread: emptyThread(),
    overlay: null,
    transcript: [],
    status: "idle",
    statusText: statusToText("idle", null),
    composer: "",
    scroll: 0,
    isStreaming: false,
    abortedMidTurn: false,
    lastError: null,
    abortController: null,
    pendingTurn: null,
  };

  // Start a fresh thread of the given mode: reset the live state and
  // persist a reset marker so restore skips earlier thread entries.
  function resetThread(mode: BtwMode): void {
    state.thread = emptyThread(mode);
    state.transcript = [];
    state.composer = "";
    state.scroll = 0;
    state.lastError = null;
    state.status = "idle";
    state.statusText = statusToText("idle", null);
    appendResetMarker(pi, mode);
  }

  pi.on("session_start", async (_event, ctx) => {
    state.thread = reconstructThreadState(ctx);
    state.transcript = rebuildTranscriptFromThread(state.thread);
    state.composer = "";
    state.scroll = 0;
    state.status = "idle";
    state.statusText = statusToText("idle", null);
    state.isStreaming = false;
    state.lastError = null;
    state.pendingTurn = null;
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (state.isStreaming && state.abortController) {
      state.abortController.abort();
    }
    state.pendingTurn = null;
    if (state.overlay) {
      state.overlay.done();
      state.overlay = null;
    }
  });

  pi.on("context", async (event, _ctx) => {
    const filtered = (event.messages as Array<{ customType?: string }>).filter(
      (m) => m.customType !== THREAD_CUSTOM_TYPE,
    );
    if (filtered.length === event.messages.length) return undefined;
    return { messages: filtered };
  });

  function toggleOverlayFocus(): void {
    const handle = state.overlay?.handle;
    if (!handle) return;
    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    state.overlay?.tui?.requestRender();
  }

  pi.registerShortcut(FOCUS_SHORTCUT_PRIMARY, {
    description: "Toggle focus between the side window and the main editor",
    handler: () => toggleOverlayFocus(),
  });
  pi.registerShortcut(FOCUS_SHORTCUT_FALLBACK, {
    description: "Toggle focus between the side window and the main editor (fallback)",
    handler: () => toggleOverlayFocus(),
  });

  async function ensureOverlayOpen(extraCtx: ExtensionCommandContext): Promise<void> {
    if (state.overlay) return;
    const smallModel = await resolveSmallModelDisplay(extraCtx);
    // Fire-and-forget: openOverlay resolves when the overlay closes, and the
    // command handler must not wait for that.
    void openOverlay(extraCtx, state, smallModel, async (text) => {
      requestSideTurn(pi, extraCtx, state, text);
    });
  }

  pi.registerCommand("btw", {
    description: "Open the side window and (optionally) ask a question: /btw [question]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const question = args.trim();
      // No question — just open the overlay. The user can type into the
      // composer and press Enter to start a side turn.
      if (!question) {
        await ensureOverlayOpen(ctx);
        return;
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        ctx.ui.notify(
          `Side question is too long (${question.length}/${MAX_QUESTION_LENGTH}).`,
          "warning",
        );
        return;
      }
      await ensureOverlayOpen(ctx);
      requestSideTurn(pi, ctx, state, question);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Reset the side thread and open the window: /btw:new [question]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const question = args.trim();
      // Reset the thread regardless of whether a question was passed.
      resetThread("contextual");
      await ensureOverlayOpen(ctx);
      ctx.ui.notify("Started a new side thread.", "info");
      if (question) {
        requestSideTurn(pi, ctx, state, question);
      }
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Open a contextless tangent: /btw:tangent [question]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const question = args.trim();
      resetThread("tangent");
      await ensureOverlayOpen(ctx);
      ctx.ui.notify("Tangent thread started (no main context).", "info");
      if (question) {
        requestSideTurn(pi, ctx, state, question);
      }
    },
  });

  pi.registerCommand("btw:reset", {
    description: "Wipe the side thread and close the side window",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("No side thread to reset.", "info");
        return;
      }
      const confirmed = await confirmModal(ctx, {
        title: "Reset side thread?",
        body: "This wipes the whole side conversation and closes the side window.",
      });
      if (!confirmed) return;
      resetThread("contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify("Side thread reset.", "info");
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Hand the full side thread back to the main agent: /btw:inject [instructions]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("Nothing to hand off — the side thread is empty.", "warning");
        return;
      }
      const instructions = args.trim();
      const confirmed = await confirmModal(ctx, {
        title: "Inject side thread?",
        body: "The full side thread is handed to the main agent and the side thread is wiped.",
      });
      if (!confirmed) return;
      const content = buildHandoffContent(state.thread, instructions, "full", "");
      const idle = ctx.isIdle();
      if (idle) pi.sendUserMessage(content);
      else pi.sendUserMessage(content, { deliverAs: "followUp" });
      resetThread("contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify(
        idle ? "Side thread injected into the main agent." : "Side thread injected as a follow-up.",
        "info",
      );
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Distill the side thread and hand a summary back: /btw:summarize [instructions]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (state.thread.messages.length === 0) {
        ctx.ui.notify("Nothing to hand off — the side thread is empty.", "warning");
        return;
      }
      const instructions = args.trim();
      const confirmed = await confirmModal(ctx, {
        title: "Summarize and inject side thread?",
        body: "The side thread is distilled, the summary is handed to the main agent, and the side thread is wiped.",
      });
      if (!confirmed) return;
      state.status = "summarizing";
      state.statusText = statusToText("summarizing", null);
      requestRender(state);
      const summary = await runSummarize(pi, ctx, state, instructions, ctx.signal);
      if (!summary) {
        state.status = "idle";
        state.statusText = statusToText("idle", state.lastError);
        ctx.ui.notify(
          state.lastError
            ? `Summarisation failed (${state.lastError}) — the side thread is preserved for a retry.`
            : "Summarisation failed — the side thread is preserved for a retry.",
          "warning",
        );
        return;
      }
      const content = buildHandoffContent(state.thread, instructions, "summary", summary);
      const idle = ctx.isIdle();
      if (idle) pi.sendUserMessage(content);
      else pi.sendUserMessage(content, { deliverAs: "followUp" });
      resetThread("contextual");
      if (state.overlay) {
        state.overlay.done();
        state.overlay = null;
      }
      ctx.ui.notify(
        idle
          ? "Side thread summarised and injected."
          : "Side thread summarised and injected as a follow-up.",
        "info",
      );
    },
  });

  pi.registerCommand("btw:thinking", {
    description: "Show or set the side thinking level: /btw:thinking [low|medium|high|none|clear]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const trimmed = args.trim();
      if (!trimmed) {
        const ov = state.thread.thinkingOverride;
        if (ov) ctx.ui.notify(`Side thinking level is ${ov} (override).`, "info");
        else {
          const { thinking: configured } = await resolveSmallModelDisplay(ctx);
          ctx.ui.notify(
            `Side thinking level inherits the global small model (${configured === "off" ? "none" : configured}).`,
            "info",
          );
        }
        return;
      }
      if (trimmed === "clear") {
        state.thread.thinkingOverride = null;
        persistThread(pi, state);
        ctx.ui.notify(
          "Side thinking level cleared — back to the global small model setting.",
          "info",
        );
        return;
      }
      if (trimmed !== "low" && trimmed !== "medium" && trimmed !== "high" && trimmed !== "none") {
        ctx.ui.notify(
          `Unknown thinking level "${trimmed}". Usage: /btw:thinking <low|medium|high|none|clear>`,
          "error",
        );
        return;
      }
      state.thread.thinkingOverride = trimmed as "none" | "low" | "medium" | "high";
      persistThread(pi, state);
      ctx.ui.notify(`Side thinking level set to ${trimmed}.`, "info");
    },
  });
}
