import { Type } from "typebox";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_ID_LENGTH = 128;
const MAX_HEADER_LENGTH = 16;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_CONTEXT_LENGTH = 4_000;
const MAX_OPTION_LABEL_LENGTH = 300;
const MAX_CUSTOM_TEXT_LENGTH = 4_000;

export interface AskUserOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskUserQuestion {
  id: string;
  header: string;
  question: string;
  context?: string;
  multiSelect?: boolean;
  options?: AskUserOption[];
}

export interface AskUserAnswer {
  questionId: string;
  selectedValues: string[];
  customText?: string;
}

export type AskUserStatus = "submitted" | "dismissed" | "aborted" | "unavailable" | "invalid";

export interface AskUserDetails {
  version: 1;
  status: AskUserStatus;
  answers: AskUserAnswer[];
}

export const AskUserOptionSchema = Type.Object({
  value: Type.String({
    minLength: 1,
    maxLength: MAX_ID_LENGTH,
    description: "Stable machine-readable value returned for this option.",
  }),
  label: Type.String({
    minLength: 1,
    maxLength: MAX_OPTION_LABEL_LENGTH,
    description: "Concise option label shown to the user.",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: MAX_CONTEXT_LENGTH,
      description: "Optional trade-off or supporting detail.",
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({
      description: "Visually mark this option as recommended without selecting it.",
    }),
  ),
});

export const AskUserQuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: MAX_ID_LENGTH,
    description: "Unique stable identifier for this question.",
  }),
  header: Type.String({
    minLength: 1,
    maxLength: MAX_HEADER_LENGTH,
    description: "Short tab label for this question.",
  }),
  question: Type.String({
    minLength: 1,
    maxLength: MAX_QUESTION_LENGTH,
    description: "The focused question shown to the user.",
  }),
  context: Type.Optional(
    Type.String({
      maxLength: MAX_CONTEXT_LENGTH,
      description: "Brief evidence or context needed to make the decision.",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description: "Allow multiple listed options. Custom text may supplement selections.",
    }),
  ),
  options: Type.Optional(
    Type.Array(AskUserOptionSchema, {
      minItems: 2,
      maxItems: MAX_OPTIONS,
      description: "Two to six choices. Do not add an Other option; the UI provides one.",
    }),
  ),
});

export const AskUserParameters = Type.Object({
  questions: Type.Array(AskUserQuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "One to four related questions answered in one reviewable form.",
  }),
});

export function validateQuestions(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    return `Provide between 1 and ${MAX_QUESTIONS} questions.`;
  }

  const questionIds = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) return `Question ${index + 1} must be an object.`;

    const idError = validateDisplayText(
      candidate.id,
      "Question id",
      MAX_ID_LENGTH,
      `question ${index + 1}`,
    );
    if (idError) return idError;
    const id = candidate.id as string;
    if (questionIds.has(id)) return `Duplicate question id: ${id}`;
    questionIds.add(id);

    const headerError = validateDisplayText(
      candidate.header,
      "Question header",
      MAX_HEADER_LENGTH,
      id,
    );
    if (headerError) return headerError;
    const questionError = validateDisplayText(
      candidate.question,
      "Question text",
      MAX_QUESTION_LENGTH,
      id,
    );
    if (questionError) return questionError;

    if (candidate.context !== undefined) {
      const contextError = validateDisplayText(
        candidate.context,
        "Question context",
        MAX_CONTEXT_LENGTH,
        id,
      );
      if (contextError) return contextError;
    }
    if (candidate.multiSelect !== undefined && typeof candidate.multiSelect !== "boolean") {
      return `Question multiSelect must be a boolean: ${id}`;
    }

    if (candidate.options === undefined) {
      if (candidate.multiSelect === true) {
        return `Question ${id} cannot enable multiSelect without options.`;
      }
      continue;
    }
    if (!Array.isArray(candidate.options)) return `Question options must be an array: ${id}`;
    if (candidate.options.length < 2 || candidate.options.length > MAX_OPTIONS) {
      return `Question ${id} must have between 2 and ${MAX_OPTIONS} options.`;
    }

    const optionValues = new Set<string>();
    for (const optionCandidate of candidate.options) {
      if (!isRecord(optionCandidate)) return `Each option in ${id} must be an object.`;

      const valueError = validateDisplayText(
        optionCandidate.value,
        "Option value",
        MAX_ID_LENGTH,
        id,
      );
      if (valueError) return valueError;
      const optionValue = optionCandidate.value as string;
      if (optionValues.has(optionValue)) {
        return `Duplicate option value in ${id}: ${optionValue}`;
      }
      optionValues.add(optionValue);

      const labelError = validateDisplayText(
        optionCandidate.label,
        "Option label",
        MAX_OPTION_LABEL_LENGTH,
        id,
      );
      if (labelError) return labelError;
      if (optionCandidate.description !== undefined) {
        const descriptionError = validateDisplayText(
          optionCandidate.description,
          "Option description",
          MAX_CONTEXT_LENGTH,
          id,
        );
        if (descriptionError) return descriptionError;
      }
      if (
        optionCandidate.recommended !== undefined &&
        typeof optionCandidate.recommended !== "boolean"
      ) {
        return `Option recommended must be a boolean in ${id}.`;
      }
    }
  }
}

export function normalizeQuestions(questions: AskUserQuestion[]): AskUserQuestion[] {
  return questions.map((question) => ({
    ...question,
    multiSelect: question.multiSelect ?? false,
    ...(question.options
      ? {
          options: [
            ...question.options.filter((option) => option.recommended === true),
            ...question.options.filter((option) => option.recommended !== true),
          ],
        }
      : {}),
  }));
}

export function normalizeCustomText(value: string): string | undefined {
  const normalized = stripTerminalControls(value).trim().slice(0, MAX_CUSTOM_TEXT_LENGTH);
  return normalized || undefined;
}

function validateDisplayText(
  value: unknown,
  field: string,
  maxLength: number,
  owner: string,
): string | undefined {
  if (typeof value !== "string") return `${field} must be a string: ${owner}`;
  if (!value.trim()) return `${field} must not be blank: ${owner}`;
  if (value.length > maxLength) return `${field} must be at most ${maxLength} characters: ${owner}`;
  if (hasTerminalControlCharacters(value)) {
    return `${field} contains terminal control characters: ${owner}`;
  }
}

function hasTerminalControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function stripTerminalControls(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code >= 32) {
      if (code < 127 || code > 159) output += value[index];
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
