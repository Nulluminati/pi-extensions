import { extractText } from "../../../lib/session-utils.ts";

const TRANSCRIPT_MAX_CHARS = 36000;

export interface HandoffEntry {
  id?: string;
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

// --- Pure utilities ---

function formatTranscriptEntry(entry: HandoffEntry): string | undefined {
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

export function buildTranscript(entries: HandoffEntry[]): string {
  const lines: string[] = [];
  let length = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;

    const line = formatTranscriptEntry(entry);
    if (!line) continue;

    const separatorLength = lines.length > 0 ? 1 : 0;
    const available = TRANSCRIPT_MAX_CHARS - length - separatorLength;
    if (available <= 0) break;

    if (line.length > available) {
      lines.unshift(available > 1 ? `${line.slice(0, available - 1)}…` : line.slice(0, available));
      break;
    }

    lines.unshift(line);
    length += line.length + separatorLength;
  }

  return lines.join("\n");
}
