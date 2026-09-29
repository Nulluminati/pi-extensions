// Non-TUI question flow: asks each question through plain ctx.ui
// input/select/confirm dialogs and reviews the answers before submitting.

import type { ExtensionContext } from "pi";
import type { QuestionnaireOutcome } from "./dialog.ts";
import { formatAnswerSummary } from "./result.ts";
import { type AskUserAnswer, type AskUserQuestion, normalizeCustomText } from "./schema.ts";

const CUSTOM_OPTION_LABEL = "Type my own answer";

export async function askWithDialogs(
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
