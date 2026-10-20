import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { wrapToolText } from "../../../lib/tool-renderer.ts";
import type { AskUserAnswer, AskUserDetails, AskUserQuestion, AskUserStatus } from "./schema.ts";

export function formatAnswerSummary(
  questions: AskUserQuestion[],
  answers: AskUserAnswer[],
): string {
  return answers
    .map((answer) => {
      const question = questions.find((candidate) => candidate.id === answer.questionId);
      const labels = answer.selectedValues.map(
        (value) => question?.options?.find((option) => option.value === value)?.label ?? value,
      );
      const parts = [...labels];
      if (answer.customText) parts.push(`wrote: ${answer.customText}`);
      return `${question?.header ?? answer.questionId}: ${parts.join("; ")}`;
    })
    .join("\n");
}

export function createStatusDetails(status: Exclude<AskUserStatus, "submitted">): AskUserDetails {
  return { version: 1, status, answers: [] };
}

export function createSubmittedDetails(answers: AskUserAnswer[]): AskUserDetails {
  return { version: 1, status: "submitted", answers };
}

export function createTerminatingResult(
  text: string,
  status: "dismissed" | "aborted" | "unavailable",
): AgentToolResult<AskUserDetails> {
  return {
    content: [{ type: "text", text }],
    details: createStatusDetails(status),
    terminate: true,
  };
}

export function renderAskResult(
  result: AgentToolResult<AskUserDetails>,
  questions: AskUserQuestion[],
  theme: Theme,
): Component {
  const details = result.details;
  if (!details) return textComponent(contentText(result));

  switch (details.status) {
    case "submitted":
      return textComponent(formatAnswerSummary(questions, details.answers));
    case "dismissed":
      return textComponent(theme.fg("warning", "Dismissed"));
    case "aborted":
      return textComponent(theme.fg("warning", "Aborted"));
    case "unavailable":
      return textComponent(theme.fg("error", "Unavailable"));
    case "invalid":
      return textComponent(theme.fg("error", "Invalid question request"));
    default:
      // pi writes details: {} when schema validation rejects the call, and
      // older sessions can carry statuses this version no longer emits.
      // Returning undefined here would be pushed into the tool block's render
      // box and crash the next render pass.
      return textComponent(contentText(result));
  }
}

export function renderAskCall(questions: AskUserQuestion[], theme: Theme): Component {
  const headers = questions.map((question) => question.header).join(", ");
  const count = questions.length;
  const text = `${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg(
    "muted",
    `${count} question${count === 1 ? "" : "s"}`,
  )}${headers ? theme.fg("dim", ` · ${headers}`) : ""}`;
  return textComponent(text);
}

function contentText(result: AgentToolResult<AskUserDetails>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function textComponent(text: string): Component {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(0, Math.floor(width));
      if (safeWidth === 0) return [];
      return wrapToolText(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, "…"));
    },
    invalidate() {},
  };
}
