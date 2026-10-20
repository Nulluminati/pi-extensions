/** Authoritative completed-event accounting. Never walk nested usage or streaming partials. */
import { createHash } from "node:crypto";

export interface Usage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  aggregate: number | null;
  providerTotal: number | null;
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown): number | null {
  const parsed =
    typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
const unknownUsage = (): Usage => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  aggregate: null,
  providerTotal: null,
});

export function normalizeUsage(value: unknown): Usage {
  const usage = object(value);
  if (!Object.keys(usage).length) return unknownUsage();
  let input: number | null;
  let output: number | null;
  let cacheRead: number | null;
  let cacheWrite: number | null;
  if (Object.hasOwn(usage, "prompt_tokens")) {
    cacheRead = number(
      object(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    );
    cacheWrite = number(usage.cache_creation_input_tokens ?? 0);
    const prompt = number(usage.prompt_tokens);
    input =
      prompt !== null && cacheRead !== null && prompt >= cacheRead ? prompt - cacheRead : null;
    output = number(usage.completion_tokens);
  } else if (Object.hasOwn(usage, "input_tokens")) {
    input = number(usage.input_tokens);
    output = number(usage.output_tokens);
    cacheRead = number(usage.cache_read_input_tokens ?? 0);
    cacheWrite = number(usage.cache_creation_input_tokens ?? 0);
  } else {
    input = number(usage.input);
    output = number(usage.output);
    cacheRead = number(usage.cacheRead ?? 0);
    cacheWrite = number(usage.cacheWrite ?? 0);
  }
  const values = [input, output, cacheRead, cacheWrite];
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    aggregate: values.every((entry) => entry !== null)
      ? values.reduce<number>((sum, entry) => sum + (entry ?? 0), 0)
      : null,
    providerTotal: number(usage.totalTokens ?? usage.total_tokens),
  };
}
export function sumUsage(values: readonly Usage[]): Usage {
  const result: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    aggregate: 0,
    providerTotal: 0,
  };
  for (const value of values)
    for (const key of Object.keys(result) as Array<keyof Usage>)
      result[key] =
        result[key] === null || value[key] === null ? null : (result[key] ?? 0) + (value[key] ?? 0);
  return result;
}

export function routeUsage(routes: readonly unknown[]): Usage {
  const seen = new Set<string>();
  const calls: Usage[] = [];
  for (const value of routes) {
    const route = object(value);
    const classifier = object(route.classifier);
    if (!classifier.attempted) continue;
    const id = typeof route.routeId === "string" ? route.routeId : JSON.stringify(route);
    if (seen.has(id)) continue;
    seen.add(id);
    calls.push(normalizeUsage(classifier.usage));
  }
  return sumUsage(calls);
}

export function classifierUsage(events: readonly unknown[]): Usage {
  const starts = new Set<string>();
  const ends = new Map<string, Usage>();
  for (const value of events) {
    const event = object(value);
    if (event.type === "classifier_start" && typeof event.routeId === "string")
      starts.add(event.routeId);
    if (event.type === "classifier_end" && typeof event.callId === "string") {
      starts.add(event.callId);
      ends.set(event.callId, normalizeUsage(event.usage));
    }
  }
  return sumUsage([...starts].map((id) => ends.get(id) ?? unknownUsage()));
}

export class EventLedger {
  private buffer = "";
  private usages: Usage[] = [];
  private seen = new Set<string>();
  private pending = 0;
  private generation = 0;
  private calls = 0;
  private retries = 0;
  private compactions = 0;
  private errors: string[] = [];
  private models = new Set<string>();
  private dispatches: Array<{
    provider: unknown;
    model: unknown;
    thinkingLevel: string | null;
    stopReason: unknown;
    usage: Usage;
  }> = [];
  private commands: string[] = [];
  private tools: string[] = [];
  private finalText = "";
  private settled = false;
  private aborted = false;
  private stopReason: string | undefined;
  push(chunk: string) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.consume(object(JSON.parse(line)));
      newline = this.buffer.indexOf("\n");
    }
  }
  private consume(event: Record<string, unknown>) {
    const message = object(event.message);
    if (event.type === "message_start" && message.role === "assistant") {
      this.pending++;
      this.generation++;
    }
    if (event.type === "auto_retry_start") this.retries++;
    if (event.type === "auto_compaction_end") {
      this.compactions++;
      this.usages.push(normalizeUsage(object(event.result).usage));
    }
    if (event.type === "agent_settled") {
      this.settled = true;
      this.aborted = event.aborted === true;
    }
    if (event.type === "tool_execution_start") {
      if (typeof event.toolName === "string") this.tools.push(event.toolName);
      const args = object(event.args);
      if (typeof args.command === "string") this.commands.push(args.command);
      if (typeof args.script === "string") this.commands.push(args.script);
    }
    if (event.type !== "message_end") return;
    const key = `${message.role === "assistant" ? this.generation : "tool"}/${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (message.role === "assistant") {
      this.pending = Math.max(0, this.pending - 1);
      this.calls++;
      const usage = normalizeUsage(message.usage);
      this.usages.push(usage);
      this.dispatches.push({
        provider: message.provider,
        model: message.model,
        thinkingLevel: typeof message.thinkingLevel === "string" ? message.thinkingLevel : null,
        stopReason: message.stopReason,
        usage,
      });
      this.models.add(`${message.provider}/${message.model}`);
      if (typeof message.errorMessage === "string") this.errors.push(message.errorMessage);
      if (typeof message.stopReason === "string") this.stopReason = message.stopReason;
      const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
      this.finalText = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } else if (
      message.role === "toolResult" &&
      message.usage !== undefined &&
      message.toolName !== "workers" &&
      message.toolName !== "spawn_worker" &&
      message.toolName !== "jev"
    )
      this.usages.push(normalizeUsage(message.usage));
  }
  finish() {
    let partialLine = false;
    if (this.buffer.trim()) {
      try {
        this.consume(object(JSON.parse(this.buffer)));
        this.buffer = "";
      } catch {
        partialLine = true;
      }
    }
    return {
      usage: sumUsage([...this.usages, ...Array.from({ length: this.pending }, unknownUsage)]),
      unknownCalls: this.pending + this.usages.filter((usage) => usage.aggregate === null).length,
      calls: this.calls,
      retries: this.retries,
      compactions: this.compactions,
      errors: [...this.errors],
      models: [...this.models],
      dispatches: [...this.dispatches],
      commands: [...this.commands],
      tools: [...this.tools],
      finalText: this.finalText,
      settled: this.settled,
      aborted: this.aborted,
      stopReason: this.stopReason,
      partialLine,
    };
  }
}
