/**
 * Goal completion evaluator.
 *
 * Runs the configured global small model against the objective and a bounded
 * view of the recent conversation, and returns a three-way verdict
 * (met / not_met / impossible). The evaluator never calls tools: like Claude
 * Code's /goal judge, it can only weigh evidence the main agent already
 * surfaced in the transcript. Any failure to resolve the model, call it, or
 * parse its verdict throws — the caller fails safe by keeping the goal active
 * and returning control to the user.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "pi";
import { extractText, extractToolCallBlocks } from "../../../lib/session-utils.ts";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { buildEvaluatorPrompt, EVALUATOR_SYSTEM_PROMPT } from "./prompts.ts";

// --- Constants ---

// Evidence window: at most this many recent message entries and this many
// transcript characters are sent to the evaluator.
const MAX_TRANSCRIPT_ENTRIES = 40;
const MAX_TRANSCRIPT_CHARS = 12_000;
const PER_MESSAGE_CHARS = 1200;
const PER_TOOL_ARGS_CHARS = 280;
const PER_RESULT_CHARS = 400;
const MAX_TOKENS = 256;

// --- Types ---

export interface EvaluatorVerdict {
  status: "met" | "not_met" | "impossible";
  reason: string;
}

interface BranchEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

// --- Helpers ---

function formatToolCallSummary(content: unknown): string[] {
  return extractToolCallBlocks(content).map((block) => {
    const summary = JSON.stringify(block.arguments ?? {}).slice(0, PER_TOOL_ARGS_CHARS);
    return `- Tool call: ${block.name}(${summary})`;
  });
}

/**
 * Render the recent conversation as evaluator-readable evidence. Keeps the
 * most recent entries: the transcript is truncated from the front when over
 * the character budget, since the latest turns carry the freshest evidence.
 */
export function buildGoalTranscript(branch: unknown[]): string {
  const messages = branch.filter(
    (entry): entry is BranchEntry =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as BranchEntry).type === "message" &&
      typeof (entry as BranchEntry).message?.role === "string",
  );
  const slice = messages.slice(-MAX_TRANSCRIPT_ENTRIES);

  const lines: string[] = [];
  for (const entry of slice) {
    const message = entry.message;
    const role = message?.role;
    const text = extractText(message?.content).trim();
    if (role === "user" && text) {
      lines.push(`User: ${text.slice(0, PER_MESSAGE_CHARS)}`);
    } else if (role === "assistant") {
      if (text) lines.push(`Assistant: ${text.slice(0, PER_MESSAGE_CHARS)}`);
      lines.push(...formatToolCallSummary(message?.content));
    } else if (role === "toolResult") {
      const name = message?.toolName ?? "tool";
      if (text) lines.push(`Result(${name}): ${text.slice(0, PER_RESULT_CHARS)}`);
    }
  }

  const transcript = lines.join("\n");
  return transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)
    : transcript;
}

export function parseVerdict(text: string): EvaluatorVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("evaluator response contained no JSON object");
  }
  let parsed: { status?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("evaluator response was not valid JSON");
  }
  if (parsed.status !== "met" && parsed.status !== "not_met" && parsed.status !== "impossible") {
    throw new Error(`evaluator returned unknown status: ${String(parsed.status)}`);
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    throw new Error("evaluator response missing reason");
  }
  return { status: parsed.status, reason };
}

// --- Evaluator ---

export async function evaluateGoal(
  objective: string,
  ctx: ExtensionContext,
): Promise<EvaluatorVerdict> {
  const resolved = await resolveSmallModel(ctx);

  const options: {
    apiKey: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    signal?: AbortSignal;
    cacheRetention: string;
    maxTokens: number;
    reasoning?: string;
  } = {
    apiKey: resolved.auth.apiKey,
    cacheRetention: "none",
    maxTokens: MAX_TOKENS,
  };
  if (resolved.auth.headers) {
    options.headers = resolved.auth.headers;
  }
  if (resolved.auth.env) {
    options.env = resolved.auth.env;
  }
  if (resolved.reasoning) {
    options.reasoning = resolved.reasoning;
  }
  if (ctx.signal) {
    options.signal = ctx.signal;
  }

  const response = await completeSimple(
    resolved.model,
    {
      systemPrompt: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildEvaluatorPrompt(
                objective,
                buildGoalTranscript(ctx.sessionManager.getBranch()),
              ),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    options,
  );

  const text = (response.content ?? [])
    .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
    .map((c: any) => c.text as string)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("evaluator returned an empty response");
  }
  return parseVerdict(text);
}
