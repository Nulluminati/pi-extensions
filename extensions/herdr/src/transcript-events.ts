/** Replay recorded worker events into read-only transcript blocks. */

import { extractText, parseContentBlocks } from "../../../lib/session-utils.ts";
import { BLOCKER_MARKER_TYPE } from "../../../lib/worker-blocker.ts";

export interface TranscriptBlock {
  kind: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "error" | "info";
  text: string;
  toolName?: string;
  isError?: boolean;
  details?: string;
}

interface Entry {
  blocks: TranscriptBlock[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "Unserializable recorded value";
  }
}

function resultText(result: Record<string, unknown>): string {
  const text = extractText(result.content);
  if (text) return text;
  return pretty(result.content ?? result);
}

export function replayTranscriptEvents(events: readonly unknown[]): TranscriptBlock[] {
  const entries: Entry[] = [];
  const messages = new Map<string, Entry>();
  const calls = new Map<string, TranscriptBlock>();
  const results = new Map<string, TranscriptBlock>();
  let active: { role: string; key: string } | undefined;
  let sequence = 0;

  function append(block: TranscriptBlock): void {
    entries.push({ blocks: [block] });
  }

  function toolCall(id: unknown, name: unknown, args: unknown, inline?: TranscriptBlock[]): void {
    if (typeof name !== "string") return;
    const key = typeof id === "string" && id ? id : `anonymous-call-${++sequence}`;
    const existing = calls.get(key);
    if (existing) {
      existing.text = pretty(args);
      existing.toolName = name;
      return;
    }
    const block: TranscriptBlock = { kind: "tool_call", toolName: name, text: pretty(args) };
    calls.set(key, block);
    if (inline) inline.push(block);
    else append(block);
  }

  function toolResult(id: unknown, name: unknown, result: unknown, isError: unknown): void {
    if (typeof name !== "string" || !object(result)) return;
    const key = typeof id === "string" && id ? id : `anonymous-result-${++sequence}`;
    const value: TranscriptBlock = {
      kind: "tool_result",
      toolName: name,
      text: resultText(result),
      ...(typeof isError === "boolean" ? { isError } : {}),
      ...(result.details !== undefined ? { details: pretty(result.details) } : {}),
    };
    const existing = results.get(key);
    if (existing) Object.assign(existing, value);
    else {
      results.set(key, value);
      append(value);
    }
  }

  for (const event of events) {
    if (!object(event)) continue;
    if (
      typeof event.type === "string" &&
      ["message_start", "message_update", "message_end"].includes(event.type) &&
      object(event.message)
    ) {
      const message = event.message;
      if (message.role === "toolResult") {
        toolResult(message.toolCallId, message.toolName, message, message.isError);
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom")
        continue;
      const role = message.role;
      const kind = role === "custom" ? "info" : role;
      const timestamp = message.timestamp;
      const key =
        typeof timestamp === "number" || typeof timestamp === "string"
          ? `${role}:${timestamp}`
          : event.type !== "message_start" && active?.role === role
            ? active.key
            : `message-${++sequence}`;
      let entry = messages.get(key);
      if (!entry) {
        entry = { blocks: [] };
        messages.set(key, entry);
        entries.push(entry);
      }
      const blocks: TranscriptBlock[] = [];
      for (const part of parseContentBlocks(message.content)) {
        const block = part as {
          type: string;
          text?: unknown;
          thinking?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (block.type === "text" && typeof block.text === "string" && block.text)
          blocks.push({ kind, text: block.text });
        else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking)
          blocks.push({ kind: "thinking", text: block.thinking });
        else if (block.type === "toolCall") {
          // Preserve the inline position across successive snapshots of this message.
          const prior = typeof block.id === "string" ? calls.get(block.id) : undefined;
          toolCall(block.id, block.name, block.arguments, blocks);
          if (prior && entry.blocks.includes(prior)) blocks.push(prior);
        }
      }
      if (typeof message.errorMessage === "string" && message.errorMessage)
        blocks.push({ kind: "error", text: message.errorMessage });
      // Final snapshots can omit content already present in recorded updates.
      const retained = entry.blocks.filter((block) =>
        block.kind === "thinking"
          ? !blocks.some((part) => part.kind === "thinking")
          : block.kind === "tool_call"
            ? !blocks.includes(block)
            : block.kind === "assistant" && !blocks.some((part) => part.kind === "assistant"),
      );
      entry.blocks = [...retained, ...blocks];
      active = event.type === "message_end" ? undefined : { role, key };
      continue;
    }
    if (event.type === "tool_execution_start")
      toolCall(event.toolCallId, event.toolName, event.args);
    else if (event.type === "tool_execution_update")
      toolResult(event.toolCallId, event.toolName, event.partialResult, event.isError);
    else if (event.type === "tool_execution_end")
      toolResult(event.toolCallId, event.toolName, event.result, event.isError);
    else if (event.type === "workers_end" || event.kind === "end") {
      if (typeof event.error === "string" && event.error)
        append({ kind: "error", text: event.error });
      else if (typeof event.status === "string")
        append({ kind: "info", text: `Worker ${event.status}` });
      if (typeof event.detail === "string" && event.detail)
        append({ kind: event.status === "failed" ? "error" : "info", text: event.detail });
    } else if (event.type === BLOCKER_MARKER_TYPE && typeof event.reason === "string")
      append({ kind: "error", text: event.reason });
    else if (event.type === "workers_start" || event.kind === "start") {
      if (typeof event.task === "string") append({ kind: "info", text: event.task });
    } else if (event.kind === "assistant" && typeof event.text === "string")
      append({ kind: "assistant", text: event.text });
    else if (
      (event.kind === "tool_start" || event.kind === "tool_end") &&
      typeof event.tool === "string"
    )
      append({
        kind: event.kind === "tool_start" ? "tool_call" : "tool_result",
        toolName: event.tool,
        text: typeof event.detail === "string" ? event.detail : "",
      });
  }
  return entries.flatMap((entry) => entry.blocks);
}
