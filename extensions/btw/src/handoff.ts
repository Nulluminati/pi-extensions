import { completeSimple, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "pi";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { SUMMARIZE_GUIDANCE } from "./constants.ts";
import type { BtwLiveState, BtwThreadState } from "./types.ts";

// --- Handoff ---

// Flatten the side thread into a plain transcript for handoff/summary.
function flattenThreadForHandoff(thread: BtwThreadState): string {
  return thread.messages
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      if (m.role === "assistant") {
        const text = m.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("");
        return `Side: ${text}`;
      }
      return `Tool(${m.toolName}) result: ${m.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("")}`;
    })
    .join("\n\n");
}

export function buildHandoffContent(
  thread: BtwThreadState,
  instructions: string,
  mode: "full" | "summary",
  summary: string,
): string {
  const header =
    mode === "full"
      ? "From a side conversation (full thread)"
      : "From a side conversation (summary)";
  const intro = instructions
    ? `User instructions for the main agent: ${instructions}\n\n`
    : "User instructions for the main agent: (none — incorporate as you see fit)\n\n";
  if (mode === "full") {
    return `${header}\n\n${intro}${flattenThreadForHandoff(thread)}`;
  }
  return `${header}\n\n${intro}${summary}`;
}

export async function runSummarize(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: BtwLiveState,
  instructions: string,
  signal?: AbortSignal,
): Promise<string | null> {
  state.lastError = null;
  let resolved: Awaited<ReturnType<typeof resolveSmallModel>>;
  try {
    resolved = await resolveSmallModel(ctx);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return null;
  }
  const transcript = flattenThreadForHandoff(state.thread);
  if (!transcript.trim()) return null;
  const steer = instructions ? `\n\nSteer the summary: ${instructions}` : "";
  const prompt = `${SUMMARIZE_GUIDANCE}${steer}\n\nSide conversation transcript:\n${transcript.slice(0, 12000)}`;
  try {
    const response = await completeSimple(
      resolved.model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        apiKey: resolved.auth.apiKey,
        ...(resolved.auth.headers ? { headers: resolved.auth.headers } : {}),
        ...(resolved.auth.env ? { env: resolved.auth.env } : {}),
        ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text || null;
  } catch (error) {
    // Keep the cause so the caller can surface it instead of a generic warning.
    state.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
