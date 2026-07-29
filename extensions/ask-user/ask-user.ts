/**
 * Ask User
 *
 * Lets the model collect one or more related user decisions in a reviewable form.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "pi";
import { QuestionnaireComponent, type QuestionnaireOutcome } from "./src/dialog.ts";
import {
  createStatusDetails,
  createSubmittedDetails,
  createTerminatingResult,
  formatAnswerSummary,
  renderAskCall,
  renderAskResult,
} from "./src/result.ts";
import {
  type AskUserAnswer,
  type AskUserDetails,
  AskUserParameters,
  type AskUserQuestion,
  normalizeCustomText,
  normalizeQuestions,
  validateQuestions,
} from "./src/schema.ts";

const TOOL_NAME = "ask_user";
const CUSTOM_OPTION_LABEL = "Type my own answer";

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

      const outcome =
        ctx.mode === "tui"
          ? await showQuestionnaire(questions, ctx, signal)
          : await askWithDialogs(questions, ctx, signal);

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

async function showQuestionnaire(
  questions: AskUserQuestion[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<QuestionnaireOutcome> {
  return ctx.ui.custom<QuestionnaireOutcome>((tui, theme, keybindings, done) => {
    let settled = false;
    const settle = (outcome: QuestionnaireOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      done(outcome);
    };
    const onAbort = () => settle({ status: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });

    const component = new QuestionnaireComponent({
      questions,
      tui,
      theme,
      keybindings,
      done: settle,
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
        signal?.removeEventListener("abort", onAbort);
        component.dispose();
      },
    };
  });
}

async function askWithDialogs(
  questions: AskUserQuestion[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<QuestionnaireOutcome> {
  const answers: AskUserAnswer[] = [];
  const dialogOptions = signal ? { signal } : {};

  for (const question of questions) {
    if (signal?.aborted) return { status: "aborted" };
    const title = question.context
      ? `${question.question}\n\nContext: ${question.context}`
      : question.question;

    if (!question.options) {
      const customText = normalizeCustomText(
        (await ctx.ui.input(title, "Type your answer", dialogOptions)) ?? "",
      );
      if (!customText) return signal?.aborted ? { status: "aborted" } : { status: "dismissed" };
      answers.push({ questionId: question.id, selectedValues: [], customText });
      continue;
    }

    if (question.multiSelect) {
      const prompt = `${title}\n\n${formatNumberedOptions(question)}\n\nChoose one or more options.`;
      const raw = await ctx.ui.input(
        prompt,
        "Comma-separated option numbers or custom text",
        dialogOptions,
      );
      if (raw === undefined) {
        return signal?.aborted ? { status: "aborted" } : { status: "dismissed" };
      }
      const answer = parseMultiSelectAnswer(question, raw);
      if (answer.selectedValues.length === 0 && !answer.customText) return { status: "dismissed" };
      answers.push(answer);
      continue;
    }

    const options = question.options.map((option, index) => `${index + 1}. ${option.label}`);
    const selected = await ctx.ui.select(title, [...options, CUSTOM_OPTION_LABEL], dialogOptions);
    if (selected === undefined) {
      return signal?.aborted ? { status: "aborted" } : { status: "dismissed" };
    }
    if (selected === CUSTOM_OPTION_LABEL) {
      const customText = normalizeCustomText(
        (await ctx.ui.input(title, "Type your answer", dialogOptions)) ?? "",
      );
      if (!customText) return signal?.aborted ? { status: "aborted" } : { status: "dismissed" };
      answers.push({ questionId: question.id, selectedValues: [], customText });
      continue;
    }

    const selectedIndex = options.indexOf(selected);
    const option = question.options[selectedIndex];
    if (!option) return { status: "dismissed" };
    answers.push({ questionId: question.id, selectedValues: [option.value] });
  }

  const accepted = await ctx.ui.confirm(
    "Review answers",
    formatAnswerSummary(questions, answers),
    dialogOptions,
  );
  if (!accepted) return signal?.aborted ? { status: "aborted" } : { status: "dismissed" };
  return { status: "submitted", answers };
}

function parseMultiSelectAnswer(question: AskUserQuestion, input: string): AskUserAnswer {
  const selectedValues: string[] = [];
  const customParts: string[] = [];
  const options = question.options ?? [];

  for (const rawPart of input.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const numericIndex = Number.parseInt(part, 10) - 1;
    const option =
      /^\d+$/.test(part) && numericIndex >= 0
        ? options[numericIndex]
        : options.find(
            (candidate) =>
              candidate.value.toLowerCase() === part.toLowerCase() ||
              candidate.label.toLowerCase() === part.toLowerCase(),
          );
    if (option) {
      if (!selectedValues.includes(option.value)) selectedValues.push(option.value);
    } else {
      customParts.push(part);
    }
  }

  const customText = normalizeCustomText(customParts.join(", "));
  return {
    questionId: question.id,
    selectedValues,
    ...(customText ? { customText } : {}),
  };
}

function formatNumberedOptions(question: AskUserQuestion): string {
  return (question.options ?? [])
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join("\n");
}

function extractQuestions(params: unknown): unknown {
  return typeof params === "object" && params !== null && "questions" in params
    ? (params as { questions?: unknown }).questions
    : undefined;
}

function safeQuestions(value: unknown): AskUserQuestion[] {
  const questions = extractQuestions(value);
  return Array.isArray(questions)
    ? questions.filter(
        (question): question is AskUserQuestion =>
          typeof question === "object" &&
          question !== null &&
          typeof (question as { id?: unknown }).id === "string" &&
          typeof (question as { header?: unknown }).header === "string" &&
          typeof (question as { question?: unknown }).question === "string",
      )
    : [];
}
