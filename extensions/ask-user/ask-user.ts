/**
 * Ask User
 *
 * Lets the model collect one or more related user decisions in a reviewable form.
 */

// --- Imports ---

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createSettleOnce } from "../../lib/settle-once.ts";
import { QuestionnaireComponent, type QuestionnaireOutcome } from "./src/dialog.ts";
import { askWithDialogs } from "./src/dialog-flow.ts";
import {
  createStatusDetails,
  createSubmittedDetails,
  createTerminatingResult,
  formatAnswerSummary,
  renderAskCall,
  renderAskResult,
} from "./src/result.ts";
import {
  type AskUserDetails,
  AskUserParameters,
  type AskUserQuestion,
  extractQuestions,
  normalizeQuestions,
  safeQuestions,
  validateQuestions,
} from "./src/schema.ts";

// --- Constants ---

const TOOL_NAME = "ask_user";

// --- Helpers ---

async function showQuestionnaire(
  questions: AskUserQuestion[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<QuestionnaireOutcome> {
  return ctx.ui.custom<QuestionnaireOutcome>(
    (tui, theme, keybindings, done) => {
      const handle = createSettleOnce(done, signal, { status: "aborted" });

      const component = new QuestionnaireComponent({
        questions,
        tui,
        theme,
        keybindings,
        done: handle.settle,
      });

      return {
        get focused() {
          return component.focused;
        },
        set focused(value: boolean) {
          component.focused = value;
        },
        render: (width) => component.render(width),
        invalidate: () => component.invalidate(),
        handleInput: (data) => component.handleInput(data),
        dispose: () => {
          handle.dispose();
          component.dispose();
        },
      };
    },
    // The questionnaire is inline, so it must announce the wait itself: pi
    // reports blocked state only for dialogs that request it.
    { blocked: { kind: "question", message: "Ask User" } },
  );
}

// --- Extension ---

export default async function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User",
    description:
      "Ask the user one to four related questions and wait for reviewed answers before proceeding. Questions may be single-select, multi-select, or freeform. The UI always provides a custom-answer path, so do not add an Other option. Gather available evidence first and ask only when the answer materially affects the work.",
    promptSnippet:
      "Ask the user one to four related decision questions in a single reviewable form",
    promptGuidelines: [
      "Use ask_user when ambiguity, preferences, or competing valid approaches materially affect the result.",
      "Before calling ask_user, gather answers available from the repository, documentation, or current conversation.",
      "Batch only related questions in one tool call; ask unrelated follow-ups separately.",
      "Call ask_user by itself before any tool calls whose effects depend on the answers.",
      "Do not use ask_user for destructive-action permission checks or questions that project conventions already answer.",
    ],
    parameters: AskUserParameters,
    executionMode: "sequential",
    // Codemode scripts must not be able to call ask_user; only the model does.
    exposure: "model-only",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawQuestions = extractQuestions(params);
      const validationError = validateQuestions(rawQuestions);
      if (validationError) {
        return {
          content: [
            { type: "text" as const, text: `Invalid ask_user request: ${validationError}` },
          ],
          details: createStatusDetails("invalid"),
        };
      }

      const questions = normalizeQuestions(rawQuestions as AskUserQuestion[]);
      if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json") {
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL_NAME));
        return createTerminatingResult(
          "ask_user requires interactive UI and has been disabled for this session.",
          "unavailable",
        );
      }

      if (signal?.aborted) {
        return createTerminatingResult("Questionnaire aborted before it opened.", "aborted");
      }

      let outcome: QuestionnaireOutcome;
      if (ctx.mode === "tui") {
        pi.events.emit("herdr:blocked", { active: true, label: "Ask User" });
        try {
          outcome = await showQuestionnaire(questions, ctx, signal);
        } finally {
          pi.events.emit("herdr:blocked", { active: false });
        }
      } else {
        outcome = await askWithDialogs(questions, ctx, signal);
      }

      if (outcome.status === "aborted") {
        return createTerminatingResult("Questionnaire aborted.", "aborted");
      }
      if (outcome.status === "dismissed") {
        return createTerminatingResult("User dismissed the questionnaire.", "dismissed");
      }

      const details = createSubmittedDetails(outcome.answers);
      return {
        content: [{ type: "text" as const, text: formatAnswerSummary(questions, outcome.answers) }],
        details,
      };
    },

    renderCall(args, theme) {
      return renderAskCall(safeQuestions(args), theme);
    },

    renderResult(result, _options, theme, context) {
      return renderAskResult(
        result as AgentToolResult<AskUserDetails>,
        safeQuestions(context.args),
        theme,
      );
    },
  });
}
