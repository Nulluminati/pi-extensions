import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  SIDE_GUIDANCE,
  SIDE_SYSTEM_PROMPT,
  SIDE_TOOL_NAMES,
  SIDE_TOOL_SNIPPETS,
  THREAD_CUSTOM_TYPE,
} from "./constants.ts";
import type { BtwLiveState, BtwMode, BtwStatus, BtwThreadState, StreamMessage } from "./types.ts";

export function threadToStreamMessages(thread: BtwThreadState): StreamMessage[] {
  const out: StreamMessage[] = [];
  for (const m of thread.messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: m.content }],
        timestamp: m.timestamp,
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content, timestamp: m.timestamp });
    } else {
      out.push({
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: m.content,
        isError: m.isError,
        timestamp: m.timestamp,
      });
    }
  }
  return out;
}

// --- Pure utilities ---

export function emptyThread(mode: BtwMode = "contextual"): BtwThreadState {
  return { mode, messages: [], thinkingOverride: null };
}

function isThreadState(value: unknown): value is BtwThreadState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.mode !== "contextual" && v.mode !== "tangent") return false;
  if (!Array.isArray(v.messages)) return false;
  const t = v.thinkingOverride;
  if (
    t !== null &&
    t !== undefined &&
    t !== "none" &&
    t !== "low" &&
    t !== "medium" &&
    t !== "high"
  )
    return false;
  return true;
}

export function reconstructThreadState(ctx: ExtensionContext): BtwThreadState {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === THREAD_CUSTOM_TYPE) {
      const data = entry.data as { state?: unknown } | undefined;
      if (data && isThreadState(data.state)) {
        // Clone before returning: the live state is mutated as turns run, and
        // we don't want those mutations to alias the persisted branch entry.
        return cloneThreadState(data.state);
      }
    }
  }
  return emptyThread();
}

function cloneThreadState(state: BtwThreadState): BtwThreadState {
  return {
    mode: state.mode,
    messages: state.messages.map((m) => {
      if (m.role === "user") return { ...m };
      if (m.role === "assistant") {
        return { ...m, content: m.content.map((b) => ({ ...b })) };
      }
      return { ...m, content: m.content.map((b) => ({ ...b })) };
    }),
    thinkingOverride: state.thinkingOverride,
  };
}

export function statusToText(status: BtwStatus, lastError: string | null): string {
  switch (status) {
    case "idle":
      return "Idle — ready for the next side question.";
    case "streaming":
      return "Streaming the side answer…";
    case "aborted":
      return "Last side turn was aborted. The thread is preserved.";
    case "failed":
      return `Last side turn failed: ${lastError ?? "unknown error"}. The thread is preserved.`;
    case "summarizing":
      return "Distilling the side thread into a summary…";
    case "queued":
      return "Side exchange queued to land after the current turn.";
  }
}

export function formatMainBackground(
  branch: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
): string {
  const lines: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const text = extractText(entry.message.content);
    if (!text) continue;
    lines.push(`[${entry.message.role}] ${truncateForBackground(text)}`);
  }
  return lines.join("\n");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" && typeof (b as { text?: string }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

function truncateForBackground(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 240)}…`;
}

export function buildSystemPrompt(
  ctx: ExtensionCommandContext,
  mode: BtwMode,
  mainBackground: string,
): string {
  const options = ctx.getSystemPromptOptions();
  const toolSnippets = options.toolSnippets ?? {};
  const toolsList = SIDE_TOOL_NAMES.map(
    (name) => `- ${name}: ${toolSnippets[name] ?? SIDE_TOOL_SNIPPETS[name]}`,
  ).join("\n");
  const parts = [SIDE_SYSTEM_PROMPT, `Available tools:\n${toolsList}`];

  if (options.contextFiles && options.contextFiles.length > 0) {
    const contextFiles = options.contextFiles
      .map(
        ({ path, content }) =>
          `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
      )
      .join("\n\n");
    parts.push(
      `<project_context>\n\nProject-specific instructions and guidelines:\n\n${contextFiles}\n\n</project_context>`,
    );
  }

  parts.push(`Current working directory: ${options.cwd.replace(/\\/g, "/")}`);
  parts.push(SIDE_GUIDANCE);
  if (mode === "contextual") {
    parts.push(
      `<main_session_background>\nThe main session the user is running in parallel is summarised below. Treat it as read-only context — the main agent is handling it. Do not duplicate that work.\n\n${mainBackground}\n</main_session_background>`,
    );
  }
  return parts.join("\n\n");
}

// --- Persistence ---

export function persistThread(pi: ExtensionAPI, state: BtwLiveState): void {
  pi.appendEntry(THREAD_CUSTOM_TYPE, { state: state.thread });
}

export function appendResetMarker(pi: ExtensionAPI, mode: BtwMode): void {
  pi.appendEntry(THREAD_CUSTOM_TYPE, { state: emptyThread(mode) });
}
