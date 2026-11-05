import { extractText, extractToolCallBlocks } from "../../../lib/session-utils.ts";
import { formatTranscriptEntry } from "../../../lib/transcript-prompt.ts";
import type { Entry } from "./types.ts";

// --- Utilities ---

function formatToolCallSummary(content: unknown): string[] {
  const blocks = extractToolCallBlocks(content);
  return blocks.map((b) => {
    const summary = JSON.stringify(b.arguments ?? {}).slice(0, 280);
    return `- ${b.name}(${summary})`;
  });
}

/**
 * Id of the last message entry on the branch, or undefined when the branch
 * has no messages. Custom entries (e.g. todos-state, goal-state) advance the
 * session leaf but are not conversation content, so staleness checks compare
 * message ids instead of leaf ids.
 */
export function lastMessageEntryId(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === "message") return e.id;
  }
  return undefined;
}

export function buildRecentTranscript(entries: Entry[], fromLastUser = true): string {
  let slice = entries;
  if (fromLastUser) {
    let lastUserIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e) continue;
      if (e.type === "message" && e.message?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) slice = entries.slice(lastUserIdx);
  }

  const lines: string[] = [];
  for (const e of slice) {
    const line = formatTranscriptEntry(e);
    if (line) lines.push(line);
    if (e.type === "message" && e.message?.role === "assistant") {
      const calls = formatToolCallSummary(e.message.content);
      if (calls.length) lines.push(...calls);
    }
  }
  return lines.join("\n");
}

/** Written into the prompt when the oldest transcript lines are dropped. */
export const OMITTED_TRANSCRIPT_MARKER = "[earlier transcript omitted]";

/**
 * Fit a transcript into a character budget by dropping whole lines from the
 * front. The newest activity always survives the cut, because a recap that
 * cannot name the last step has no value. The marker tells the model that the
 * transcript starts mid-turn.
 */
export function fitTranscriptTail(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;

  const lines = transcript.split("\n");
  const budget = maxChars - OMITTED_TRANSCRIPT_MARKER.length - 1;
  // Too small to hold the marker and any line: fall back to a plain tail cut.
  if (budget < 1) return transcript.slice(Math.max(0, transcript.length - maxChars));

  let start = lines.length;
  let length = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const cost = start === lines.length ? line.length : line.length + 1;
    if (length + cost > budget) break;
    length += cost;
    start = i;
  }

  if (start === lines.length) {
    // A single line exceeds the budget on its own: keep the tail of that line.
    const last = lines[lines.length - 1] ?? "";
    return [OMITTED_TRANSCRIPT_MARKER, last.slice(Math.max(0, last.length - budget))].join("\n");
  }
  return [OMITTED_TRANSCRIPT_MARKER, ...lines.slice(start)].join("\n");
}

export function hasMeaningfulActivity(entries: Entry[]): boolean {
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === "message" && e.message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const tail = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
  let assistantWords = 0;
  let toolCalls = 0;
  for (const e of tail) {
    if (e.type !== "message") continue;
    if (e.message?.role === "assistant") {
      const t = extractText(e.message.content);
      assistantWords += t.split(/\s+/).filter(Boolean).length;
      toolCalls += formatToolCallSummary(e.message.content).length;
    }
  }
  return toolCalls > 0 || assistantWords >= 50;
}
