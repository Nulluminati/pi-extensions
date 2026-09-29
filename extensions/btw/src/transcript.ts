import type { AssistantMessageEvent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BtwLiveState, BtwThreadState, TranscriptEntry } from "./types.ts";

export function previewToolArgs(args: unknown): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  return truncateToWidth(raw, 200, "…");
}

export function extractToolResultText(content: TextContent[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function previewToolResultText(text: string): string {
  if (text.length <= 500) return text;
  return `${text.slice(0, 500)}\n[truncated]`;
}

export function rebuildTranscriptFromThread(thread: BtwThreadState): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of thread.messages) {
    if (m.role === "user") {
      out.push({ kind: "user", text: m.content });
    } else if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("");
      const thinking = m.content
        .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
        .map((b) => b.thinking)
        .join("");
      const toolCalls = m.content.filter((b): b is ToolCall => b.type === "toolCall");
      if (thinking) out.push({ kind: "assistant-thinking", text: thinking });
      if (text) out.push({ kind: "assistant-text", text });
      for (const call of toolCalls) {
        const args = parseToolArgs(call.arguments);
        out.push({
          kind: "tool-call",
          text: `${call.name}(${previewToolArgs(args)})`,
          meta: { name: call.name, args: previewToolArgs(args) },
        });
      }
    } else if (m.role === "toolResult") {
      const text = extractToolResultText(m.content);
      out.push({ kind: "tool-result", text: previewToolResultText(text), failed: m.isError });
    }
  }
  return out;
}

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

// --- Transcript rendering (plain string lines, fed to TUI) ---

export type ThemeLite = {
  bold: (s: string) => string;
  fg: (c: string, s: string) => string;
  italic?: (s: string) => string;
  dim?: (s: string) => string;
};

export function buildTranscriptLines(
  entries: TranscriptEntry[],
  width: number,
  theme: ThemeLite,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        out.push(theme.fg("accent", `▸ you: ${entry.text}`));
        break;
      }
      case "assistant-text": {
        const cursor = entry.streaming ? "▌" : "";
        out.push(theme.fg("success", `▸ btw: ${entry.text}${cursor}`));
        break;
      }
      case "assistant-thinking": {
        out.push(
          theme.italic?.(
            theme.dim?.(`  ↳ thinking: ${entry.text}`) ?? `  ↳ thinking: ${entry.text}`,
          ) ?? `  ↳ thinking: ${entry.text}`,
        );
        break;
      }
      case "tool-call": {
        const name = String(entry.meta?.name ?? "tool");
        const args = String(entry.meta?.args ?? "");
        out.push(
          theme.dim?.(`  ↳ ${name}(${truncateToWidth(args, Math.max(8, width - 12), "…")})`) ??
            `  ↳ ${name}(${args})`,
        );
        break;
      }
      case "tool-result": {
        const prefix = entry.failed
          ? theme.fg("error", "  ↳ result (error): ")
          : (theme.dim?.("  ↳ result: ") ?? "  ↳ result: ");
        out.push(`${prefix}${entry.text}`);
        break;
      }
      case "status": {
        out.push(theme.dim?.(`  · ${entry.text}`) ?? `  · ${entry.text}`);
        break;
      }
      case "error": {
        out.push(theme.fg("error", `  ✗ ${entry.text}`));
        break;
      }
    }
  }
  return out;
}

export function processStreamEvent(
  state: BtwLiveState,
  event: AssistantMessageEvent,
  onText: (s: string) => void,
  onThinking: (s: string) => void,
  onToolCall: (call: ToolCall) => void,
): void {
  switch (event.type) {
    case "text_start":
      onText("");
      return;
    case "text_delta": {
      const last = lastAssistantTextEntry(state);
      const next = (last?.text ?? "") + event.delta;
      onText(next);
      if (last) {
        const idx = state.transcript.lastIndexOf(last);
        state.transcript[idx] = { ...last, text: next };
      }
      state.statusText = "Streaming the side answer…";
      requestRender(state);
      return;
    }
    case "text_end":
      onText(event.content);
      return;
    case "thinking_start":
      onThinking("");
      // Close any in-progress thinking block so a second block in the same
      // turn (rare) lands in its own entry instead of appending to the first.
      state.transcript = state.transcript.map((e) =>
        e.kind === "assistant-thinking" && e.streaming ? { ...e, streaming: false } : e,
      );
      requestRender(state);
      return;
    case "thinking_delta": {
      const idx = openThinkingEntry(state);
      const existing = state.transcript[idx];
      if (!existing) return;
      const next = existing.text + event.delta;
      onThinking(next);
      state.transcript[idx] = { ...existing, text: next, streaming: true };
      state.statusText = "Streaming the side answer…";
      requestRender(state);
      return;
    }
    case "thinking_end":
      onThinking(event.content);
      return;
    case "toolcall_start":
    case "toolcall_delta":
      return;
    case "toolcall_end": {
      onToolCall(event.toolCall);
      const args = parseToolArgs(event.toolCall.arguments);
      const preview = previewToolArgs(args);
      state.transcript.push({
        kind: "tool-call",
        text: `${event.toolCall.name}(${preview})`,
        meta: { name: event.toolCall.name, args: preview },
      });
      requestRender(state);
      return;
    }
    case "done":
    case "error":
      return;
  }
}

function lastAssistantTextEntry(state: BtwLiveState): TranscriptEntry | undefined {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-text") return e;
  }
  return undefined;
}

/**
 * Find the current turn's open (streaming) thinking entry, or create one.
 * A fresh entry is inserted immediately before the current turn's
 * streaming text placeholder so thinking renders above the answer. This
 * scoping is what keeps each turn's thinking in its own block — without
 * it, `thinking_delta` would latch onto the previous turn's entry.
 */
function openThinkingEntry(state: BtwLiveState): number {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-thinking" && e.streaming) return i;
  }
  let insertAt = state.transcript.length;
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const e = state.transcript[i];
    if (e && e.kind === "assistant-text" && e.streaming) {
      insertAt = i;
      break;
    }
  }
  state.transcript.splice(insertAt, 0, {
    kind: "assistant-thinking",
    text: "",
    streaming: true,
  });
  return insertAt;
}

/** Finalize the current turn's streaming text/thinking entries to their
 *  final buffer values and clear the streaming flag. Mirrored for both
 *  kinds so thinking is scoped per turn just like text. */
export function finalizeTurnEntries(
  transcript: TranscriptEntry[],
  textBuffer: string,
  thinkingBuffer: string,
): TranscriptEntry[] {
  return transcript.map((e) => {
    if (e.kind === "assistant-text" && e.streaming) {
      return { ...e, text: textBuffer, streaming: false };
    }
    if (e.kind === "assistant-thinking" && e.streaming) {
      return { ...e, text: thinkingBuffer, streaming: false };
    }
    return e;
  });
}

export function requestRender(state: BtwLiveState): void {
  state.overlay?.tui?.requestRender();
}
