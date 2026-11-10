import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSmallModel } from "../../../lib/small-model.ts";

const SUMMARY_MAX_TOKENS = 2048;

export interface SummaryOk {
  ok: true;
  text: string;
}

export interface SummaryError {
  ok: false;
  error: string;
}

export type SummaryResult = SummaryOk | SummaryError;

function buildSummarySystemPrompt(): string {
  return `You prepare concise handoff summaries for a coding agent session.

Your output will be placed directly into the editor of a new Pi session so the user can continue work with a smaller context window.

Include:
- The user's original request and the current goal
- What has been completed so far
- Key decisions, findings, files touched, or commands run
- What remains to be done
- Concrete next steps or constraints

Rules:
- Be concise but complete (a few paragraphs, not a full transcript).
- Do not add greetings, sign-offs, or meta-commentary.
- Do not wrap the output in markdown code fences.
- Output only the continuation prompt, ready for the user to review and send.`;
}

function buildSummaryUserMessage(transcript: string, goal: string): string {
  // No goal line when handoff is invoked without one; the model then infers
  // the focus from the transcript alone.
  const goalLine = goal
    ? `Goal for the new session: ${goal}

`
    : "";
  return `${goalLine}<conversation_transcript>
${transcript}
</conversation_transcript>

Write the handoff prompt.`;
}

export async function generateSummary(
  transcript: string,
  goal: string,
  ctx: ExtensionContext,
): Promise<SummaryResult> {
  try {
    const resolved = await resolveSmallModel(ctx);
    const options: SimpleStreamOptions = {
      apiKey: resolved.auth.apiKey,
      maxTokens: SUMMARY_MAX_TOKENS,
    };
    if (resolved.auth.headers) options.headers = resolved.auth.headers;
    if (resolved.auth.env) options.env = resolved.auth.env;
    if (ctx.signal) options.signal = ctx.signal;
    if (resolved.reasoning) options.reasoning = resolved.reasoning;

    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: buildSummarySystemPrompt(),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildSummaryUserMessage(transcript, goal) }],
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );

    // completeSimple resolves (does not throw) on provider failures, so the
    // error has to be read from the stop reason.
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return {
        ok: false,
        error: `Failed to generate handoff summary: ${response.errorMessage || response.stopReason}`,
      };
    }

    const text = response.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block?.type === "text" && typeof (block as { text?: string }).text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      return { ok: false, error: "Model returned an empty handoff summary." };
    }

    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to generate handoff summary: ${message}` };
  }
}
