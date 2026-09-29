/**
 * Shared transcript-to-prompt formatting.
 *
 * Extensions that feed a textual view of the session transcript to an LLM
 * (handoff summaries, session recaps) share the per-entry line format:
 * `User: …`, `Assistant: …`, and `Result(<toolName>): …` with fixed per-role
 * truncation.
 */

import { extractText } from "./session-utils.ts";

// --- Types ---

/** Loose view of a session transcript entry: only the fields callers read. */
export interface TranscriptEntry {
  id?: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

// --- Helpers ---

/**
 * Format one session entry as a prompt line, or undefined when the entry
 * carries no displayable text. User and assistant text is truncated to 1200
 * characters, tool result text to 400.
 */
export function formatTranscriptEntry(entry: TranscriptEntry): string | undefined {
  if (entry.type !== "message" || !entry.message?.role) return undefined;

  const role = entry.message.role;
  const text = extractText(entry.message.content).trim();

  if (role === "user" && text) {
    return `User: ${text.slice(0, 1200)}`;
  }
  if (role === "assistant" && text) {
    return `Assistant: ${text.slice(0, 1200)}`;
  }
  if (role === "toolResult" && text) {
    const name = entry.message.toolName ?? "tool";
    return `Result(${name}): ${text.slice(0, 400)}`;
  }
  return undefined;
}
