/**
 * Handoff Extension
 *
 * Provides a `/handoff` command that summarizes the current session into a
 * compact, continuation-ready prompt, then opens a new Pi session with that
 * prompt pre-filled in the editor.
 *
 * Usage:
 *   /handoff finish the auth refactor and add tests
 *   /handoff                        (prompts for a goal)
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";

// --- Constants ---

// Status-bar indicator: a Nerd Font swap icon in a distinct accent hue with a
// greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf04e1); // nf-md-swap-horizontal
export const ICON_COLOR = "accent";
export const TEXT_COLOR = "muted";

const STATUS_KEY = "handoff";
const GOAL_MAX_LENGTH = 4000;
const TRANSCRIPT_MAX_CHARS = 12000;
const SUMMARY_MAX_TOKENS = 2048;

// --- Types ---

interface HandoffEntry {
  id?: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

interface SummaryResult {
  ok: true;
  text: string;
}

interface SummaryError {
  ok: false;
  error: string;
}

// --- Pure utilities ---

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" && typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function buildTranscript(entries: HandoffEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;

    const role = entry.message.role;
    const text = extractText(entry.message.content).trim();

    if (role === "user" && text) {
      lines.push(`User: ${text.slice(0, 1200)}`);
    } else if (role === "assistant" && text) {
      lines.push(`Assistant: ${text.slice(0, 1200)}`);
    } else if (role === "toolResult" && text) {
      const name = entry.message.toolName ?? "tool";
      lines.push(`Result(${name}): ${text.slice(0, 400)}`);
    }
  }
  return lines.join("\n");
}

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
  return `Goal for the new session: ${goal}

<conversation_transcript>
${transcript.slice(0, TRANSCRIPT_MAX_CHARS)}
</conversation_transcript>

Write the handoff prompt.`;
}

function formatGoalForSessionName(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "Handoff session";
  // Capitalize first letter, keep it short.
  const headline = trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
  return headline.length > 60 ? `${headline.slice(0, 59)}…` : headline;
}

async function generateSummary(
  transcript: string,
  goal: string,
  ctx: ExtensionContext,
): Promise<SummaryResult | SummaryError> {
  const model = ctx.model;
  if (!model) {
    return { ok: false, error: "No model selected. Use /model to select a model first." };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) {
    return { ok: false, error: "No API key available for the active model." };
  }

  const options: {
    apiKey: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxTokens: number;
  } = {
    apiKey: auth.apiKey,
    maxTokens: SUMMARY_MAX_TOKENS,
  };
  if (auth.headers) options.headers = auth.headers;
  if (ctx.signal) options.signal = ctx.signal;

  try {
    const response = await completeSimple(
      model,
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

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  } else if (type === "error") {
    console.error(message);
  } else if (type === "warning") {
    console.warn(message);
  } else {
    console.log(message);
  }
}

async function resolveGoal(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) {
    if (trimmed.length > GOAL_MAX_LENGTH) {
      notify(
        ctx,
        `Goal is too long (${trimmed.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
        "warning",
      );
      return undefined;
    }
    return trimmed;
  }

  if (!ctx.hasUI) {
    notify(ctx, "Usage: /handoff <goal>", "warning");
    return undefined;
  }

  const goal = await ctx.ui.input("Handoff goal", "What should the new session focus on?");
  if (!goal) return undefined;

  if (goal.length > GOAL_MAX_LENGTH) {
    notify(
      ctx,
      `Goal is too long (${goal.length}/${GOAL_MAX_LENGTH} characters). Shorten it or put details in a file and reference it.`,
      "warning",
    );
    return undefined;
  }

  return goal;
}

// --- Default export ---

export default async function handoffExtension(pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Summarize the current session and start a new focused session",
    handler: async (args, ctx) => {
      const goal = await resolveGoal(args, ctx);
      if (!goal) return;

      if (!ctx.model) {
        notify(ctx, "No model selected. Use /model to select a model first.", "error");
        return;
      }

      const entries = ctx.sessionManager.getBranch() as HandoffEntry[];
      const transcript = buildTranscript(entries);
      if (!transcript.trim()) {
        notify(ctx, "No conversation to hand off.", "error");
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "Generating handoff summary…")}`,
        );
      }

      const summary = await generateSummary(transcript, goal, ctx);

      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }

      if (!summary.ok) {
        notify(ctx, summary.error, "error");
        return;
      }

      // Print mode: emit the summary and stop.
      if (!ctx.hasUI) {
        console.log(summary.text);
        return;
      }

      const editedSummary = await ctx.ui.editor("Review handoff prompt", summary.text);
      if (editedSummary === undefined) {
        notify(ctx, "Handoff cancelled.", "info");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const sessionName = formatGoalForSessionName(goal);

      const newSessionOptions: {
        parentSession?: string;
        withSession: (newCtx: any) => Promise<void>;
      } = {
        withSession: async (newCtx) => {
          newCtx.ui.setEditorText(editedSummary);
          newCtx.ui.notify("Handoff ready. Press Enter to continue in the new session.", "info");
        },
      };
      if (currentSessionFile) {
        newSessionOptions.parentSession = currentSessionFile;
      }

      const result = await ctx.newSession(newSessionOptions);

      if (result.cancelled) {
        notify(ctx, "New session cancelled.", "info");
        return;
      }

      pi.setSessionName(sessionName);
      notify(ctx, `Handoff complete. New session: ${sessionName}`, "info");
    },
  });
}
