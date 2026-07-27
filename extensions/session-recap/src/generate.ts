import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "pi";
import { resolveSmallModel } from "../../../lib/small-model.ts";

export async function generateRecap(
  transcript: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const resolved = await resolveSmallModel(ctx);

  const prompt = `You produce a single-line recap of what the coding agent just did, so the user can re-enter flow after switching focus back to this session.

Rules:
- Output ONE line, no preamble, no markdown.
- Format: \`recap: <what happened, past tense, concrete>. Next: <one-line next step>.\`
- If there is no meaningful next step, omit the \`Next:\` clause.
- If the transcript shows the turn was aborted or errored, say so explicitly.
- Use file/function names where relevant. Be concrete, not vague.
- Max ~220 characters.

<transcript>
${transcript.slice(0, 12000)}
</transcript>`;

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
    maxTokens: 256,
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
  if (signal) {
    options.signal = signal;
  }

  const response = await completeSimple(
    resolved.model,
    {
      systemPrompt: "You write terse, concrete session recaps for a coding agent UI.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    options,
  );

  if (!response.content) return undefined;
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  return text ? text.split(/\r?\n/, 1)[0]?.trim() : undefined;
}
