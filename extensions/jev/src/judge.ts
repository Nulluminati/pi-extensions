/** Validate bounded judgments without turning probabilities into permission or certainty. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentToolResult,
  ClassifierAnswer,
  ClassifierContext,
  ClassifierResult,
  ExtensionContext,
} from "pi";
import { Check } from "typebox/value";
import { writeJsonAtomic } from "../../../lib/json-atomic.ts";
import type { JevParameters } from "./schema.ts";
import { JEV_PARAMETERS, MAX_REQUEST_BYTES } from "./schema.ts";

// --- Constants ---

const MAX_TEXT_BYTES = 50 * 1024;

// --- Types ---

type JevDetails = JevOutcome & { fullResultPath?: string };

type JevOutcome =
  | {
      status: "ok";
      provider: string;
      model: string;
      answers: Record<string, ClassifierAnswer>;
      usage?: ClassifierResult["usage"];
    }
  | { status: "error"; error: string; usage?: ClassifierResult["usage"] };

// --- Validation ---

function parameters(value: unknown): value is JevParameters {
  return Check(JEV_PARAMETERS, value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  return (
    record(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every((item) => jsonValue(item, depth + 1))
  );
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameKeys(left: object, right: object): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key))
  );
}

function validateAnswers(
  context: ClassifierContext,
  answers: unknown,
): Record<string, ClassifierAnswer> {
  if (!record(answers) || !sameKeys(context.questions, answers)) {
    throw new Error("Invalid classifier answers: expected exactly one answer per question.");
  }
  return Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => {
      const answer = answers[id];
      const invalid = () =>
        new Error(`Invalid classifier answer for question ${JSON.stringify(id)}.`);
      if (!record(answer) || answer.type !== question.type) throw invalid();
      let validated: ClassifierAnswer;
      switch (question.type) {
        case "bool":
          if (!probability(answer.probability)) throw invalid();
          validated = { type: "bool", probability: answer.probability };
          break;
        case "score":
          if (
            typeof answer.score !== "number" ||
            !Number.isFinite(answer.score) ||
            answer.score < 0 ||
            answer.score > question.criteria.length - 1 ||
            !probability(answer.confidence)
          )
            throw invalid();
          validated = { type: "score", score: answer.score, confidence: answer.confidence };
          break;
        case "choice": {
          const distribution = answer.probabilities;
          if (
            typeof answer.choice !== "string" ||
            !Object.hasOwn(question.criteria, answer.choice) ||
            !probability(answer.confidence) ||
            !record(distribution) ||
            !sameKeys(question.criteria, distribution)
          )
            throw invalid();
          const values = Object.values(distribution);
          if (!values.every(probability)) throw invalid();
          const total = values.reduce((sum, value) => sum + value, 0);
          const selected = distribution[answer.choice];
          if (
            !probability(selected) ||
            Math.abs(total - 1) > 0.01 ||
            selected + 1e-9 < Math.max(...values)
          )
            throw invalid();
          validated = {
            type: "choice",
            choice: answer.choice,
            probabilities: Object.fromEntries(Object.entries(distribution)) as Record<
              string,
              number
            >,
            confidence: answer.confidence,
          };
          break;
        }
      }
      return [id, validated];
    }),
  );
}

async function toolResult(details: JevDetails): Promise<AgentToolResult<JevDetails>> {
  let text = JSON.stringify(details);
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    let directory: string | undefined;
    let message =
      "Result exceeds 50 KiB. Read fullResultPath in bounded sections for the complete result. Structured output contains all answers.";
    try {
      directory = await mkdtemp(join(tmpdir(), "pi-jev-"));
      const fullResultPath = join(directory, "result.json");
      await writeJsonAtomic(fullResultPath, details, { mode: 0o600 });
      details = { ...details, fullResultPath };
    } catch {
      message =
        "Result exceeds 50 KiB. Could not save the temporary result file. The full result remains in structured output and details.";
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          message += " Temporary-file cleanup also failed.";
        }
      }
    }
    text = JSON.stringify({
      status: details.status,
      ...(details.fullResultPath ? { fullResultPath: details.fullResultPath } : {}),
      message,
    });
  }
  return {
    content: [{ type: "text", text }],
    details,
    structuredContent: details,
    ...(details.usage ? { usage: details.usage } : {}),
    ...(details.status === "error" ? { isError: true } : {}),
  };
}

// --- Judging ---

export async function executeJev(
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<JevDetails>> {
  let usage: ClassifierResult["usage"];
  try {
    if (!parameters(params)) {
      throw new Error(
        "Invalid state, questions, criteria, instructions, or model. Supply a JSON state object and 1–64 bool, choice, or score questions with nonblank instructions and criteria.",
      );
    }
    if (!jsonValue(params.state)) {
      throw new Error("State must contain finite JSON values with at most 64 nesting levels.");
    }
    for (const [id, question] of Object.entries(params.questions)) {
      if (
        !id.trim() ||
        (question.type === "choice" && Object.keys(question.criteria).some((key) => !key.trim()))
      ) {
        throw new Error("Questions and choice criteria must use nonblank IDs.");
      }
    }
    const context: ClassifierContext = { state: params.state, questions: params.questions };
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(
        `State and questions exceed ${MAX_REQUEST_BYTES} bytes (64 KiB). Split the request; no input was truncated.`,
      );
    }
    const requestSignal = signal ?? ctx.signal;
    if (requestSignal?.aborted) throw new Error("Jev request cancelled.");
    const modelSpec = params.model ?? "typesafe/jev-latest";
    const slash = modelSpec.indexOf("/");
    const provider = modelSpec.slice(0, slash);
    const id = modelSpec.slice(slash + 1);
    const model = ctx.modelRegistry.findOfType("classifier", provider, id);
    if (!model)
      throw new Error(
        `Classifier ${modelSpec} is unavailable. Check Pi's classifier catalog and provider configuration.`,
      );
    const result = await ctx.modelRegistry.classify(model, context, {
      ...(requestSignal ? { signal: requestSignal } : {}),
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    usage = result.usage;
    if (requestSignal?.aborted) throw new Error("Jev request cancelled.");
    if (result.stopReason !== "stop") {
      throw new Error(
        result.errorMessage ||
          (result.stopReason === "aborted"
            ? "Jev request cancelled."
            : "Jev classifier request failed. Check provider credentials and service availability."),
      );
    }
    const answers = validateAnswers(context, result.answers);
    return await toolResult({
      status: "ok",
      provider: result.provider,
      model: result.model,
      answers,
      ...(usage ? { usage } : {}),
    });
  } catch (error) {
    return toolResult({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      ...(usage ? { usage } : {}),
    });
  }
}
