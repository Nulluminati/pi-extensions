/**
 * Handoff Extension
 *
 * Provides a `/handoff` command that summarizes the current session into a
 * compact, continuation-ready prompt, then opens a new Pi session with that
 * prompt pre-filled in the editor.
 *
 * Usage:
 *   /handoff finish the auth refactor and add tests
 *   /handoff                        (drafts a general summary)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderModalFrame } from "../../lib/tui-frame.ts";
import { formatGoalForSessionName, resolveGoal } from "./src/goal.ts";
import { generateSummary, type SummaryResult } from "./src/summary.ts";
import { buildTranscript, type HandoffEntry } from "./src/transcript.ts";

// --- Constants ---

// Braille spinner frames, advanced on each render tick while the summary is
// being generated. The interval only drives requestRender; the frame index
// advances in render so repaints from any source stay in sync.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_INTERVAL_MS = 100;

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
      if (goal === undefined) return;

      const entries = ctx.sessionManager.getBranch() as HandoffEntry[];
      const transcript = buildTranscript(entries);
      if (!transcript.trim()) {
        if (ctx.hasUI) {
          ctx.ui.notify("No conversation to hand off.", "error");
        }
        return;
      }

      let summary: SummaryResult;
      if (ctx.hasUI) {
        const pending = generateSummary(transcript, goal, ctx);
        summary = await ctx.ui.custom<SummaryResult>((tui, theme, _keybindings, done) => {
          // Resolve the modal when the summary finishes; generation started
          // before the modal opened so no time is lost to the paint.
          void pending.then(done);

          const t = tui as { requestRender: () => void };
          let frameIndex = 0;
          const tick = setInterval(() => t.requestRender(), SPINNER_INTERVAL_MS);
          tick.unref();

          return {
            render(width: number): string[] {
              const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "⠋";
              frameIndex++;
              const spinner = theme.fg("accent", frame);
              const text = theme.fg("dim", "Generating summary…");
              return renderModalFrame(theme, width, [`${spinner} ${text}`], {
                title: "Handoff",
              });
            },
            invalidate(): void {},
            // Swallow input: the modal is informational and closes itself
            // when the summary lands.
            handleInput(): void {},
            dispose(): void {
              clearInterval(tick);
            },
          };
        });
      } else {
        summary = await generateSummary(transcript, goal, ctx);
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
