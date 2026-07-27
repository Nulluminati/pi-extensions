import { extractText, extractToolCallBlocks } from "../../../lib/session-utils.ts";
import type { Entry } from "./types.ts";

// --- Utilities ---

function formatToolCallSummary(content: unknown): string[] {
  const blocks = extractToolCallBlocks(content);
  return blocks.map((b) => {
    const summary = JSON.stringify(b.arguments ?? {}).slice(0, 280);
    return `- ${b.name}(${summary})`;
  });
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
    if (e.type !== "message" || !e.message?.role) continue;
    const role = e.message.role;
    if (role === "user") {
      const t = extractText(e.message.content).trim();
      if (t) lines.push(`User: ${t.slice(0, 1200)}`);
    } else if (role === "assistant") {
      const t = extractText(e.message.content).trim();
      if (t) lines.push(`Assistant: ${t.slice(0, 1200)}`);
      const calls = formatToolCallSummary(e.message.content);
      if (calls.length) lines.push(...calls);
    } else if (role === "toolResult") {
      const t = extractText(e.message.content).trim();
      const name = e.message.toolName ?? "tool";
      if (t) lines.push(`Result(${name}): ${t.slice(0, 400)}`);
    }
  }
  return lines.join("\n");
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
