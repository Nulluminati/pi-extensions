/**
 * Handoff Extension
 *
 * Provides a `/handoff` command that summarizes the current session into a
 * compact, continuation-ready prompt, then opens a new Pi session with that
 * prompt pre-filled in the editor.
 *
 * Usage:
 *   /handoff finish the auth refactor and add tests
 *   /handoff                        (prompts for a goal)
 */

import type { ExtensionAPI } from "pi";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { ICON_COLOR, STATUS_ICON, STATUS_KEY, TEXT_COLOR } from "./src/constants.ts";
import { formatGoalForSessionName, resolveGoal } from "./src/goal.ts";
import { generateSummary } from "./src/summary.ts";
import { buildTranscript, type HandoffEntry } from "./src/transcript.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR };

// --- Types ---

interface HandoffSessionManager {
  appendSessionInfo(name: string): unknown;
}

interface HandoffReplacementContext {
  ui: {
    setEditorText(text: string): void;
    notify(message: string, type: "info" | "warning" | "error"): void;
  };
}

// --- Extension ---

export default async function handoffExtension(pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Summarize the current session and start a new focused session",
    handler: async (args, ctx) => {
      const goal = await resolveGoal(args, ctx);
      if (!goal) return;

      const entries = ctx.sessionManager.getBranch() as HandoffEntry[];
      const transcript = buildTranscript(entries);
      if (!transcript.trim()) {
        if (ctx.hasUI) {
          ctx.ui.notify("No conversation to hand off.", "error");
        }
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          STATUS_KEY,
          formatStatusLine(ctx.ui.theme, {
            icon: STATUS_ICON,
            prefix: "Handoff",
            text: "generating summary…",
            iconColor: ICON_COLOR,
            textColor: TEXT_COLOR,
          }),
        );
      }

      const summary = await generateSummary(transcript, goal, ctx);

      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }

      if (!summary.ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(summary.error, "error");
        } else {
          console.error(summary.error);
        }
        return;
      }

      // Print mode: emit the summary and stop.
      if (!ctx.hasUI) {
        console.log(summary.text);
        return;
      }

      const editedSummary = await ctx.ui.editor("Review handoff prompt", summary.text);
      if (editedSummary === undefined) {
        ctx.ui.notify("Handoff cancelled.", "info");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const sessionName = formatGoalForSessionName(goal);

      const newSessionOptions: {
        parentSession?: string;
        setup: (sessionManager: HandoffSessionManager) => Promise<void>;
        withSession: (newCtx: HandoffReplacementContext) => Promise<void>;
      } = {
        setup: async (sessionManager) => {
          sessionManager.appendSessionInfo(sessionName);
        },
        withSession: async (newCtx) => {
          newCtx.ui.setEditorText(editedSummary);
          newCtx.ui.notify("Handoff ready. Press Enter to continue in the new session.", "info");
        },
      };
      if (currentSessionFile) {
        newSessionOptions.parentSession = currentSessionFile;
      }

      const result = await ctx.newSession(newSessionOptions);

      if (result.cancelled) {
        ctx.ui.notify("New session cancelled.", "info");
      }
    },
  });
}
