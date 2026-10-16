import { sumSessionUsage } from "../../lib/session-usage.ts";

export interface RunMetrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  topLevelToolCalls: number;
  codemodeCalls: number;
  nestedCalls: number;
  nestedCallsComplete: boolean;
  codemodeFailures: number;
  stopReason: string;
  finalText: string;
  settled: boolean;
  aborted: boolean;
  models: string[];
  commands: string[];
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Consume decoded UTF-8 chunks. Only LF ends a record; U+2028/U+2029 are data. */
export class JsonlMetrics {
  private buffer = "";
  private usageEntries: unknown[] = [];
  private models = new Set<string>();
  private commands = new Set<string>();
  private metrics: Omit<
    RunMetrics,
    "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "cost" | "models" | "commands"
  > = {
    topLevelToolCalls: 0,
    codemodeCalls: 0,
    nestedCalls: 0,
    nestedCallsComplete: true,
    codemodeFailures: 0,
    stopReason: "missing",
    finalText: "",
    settled: false,
    aborted: false,
  };

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consume(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 16 * 1024 * 1024) throw new Error("JSONL record exceeds 16 MiB");
  }

  finish(): RunMetrics {
    if (this.buffer) {
      this.consume(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
    return this.snapshot();
  }

  snapshot(): RunMetrics {
    return {
      ...sumSessionUsage(this.usageEntries),
      ...this.metrics,
      models: [...this.models].sort(),
      commands: [...this.commands],
    };
  }

  private consume(line: string): void {
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      event = object(value);
      if (typeof event.type !== "string") throw new Error("expected an event object");
    } catch (error) {
      throw new Error(
        `Invalid JSONL record: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (event.type === "message_end") {
      const message = object(event.message);
      // Keep only accounting fields, not the potentially large tool output.
      this.usageEntries.push({
        type: "message",
        message: { role: message.role, usage: message.usage },
      });
      if (message.role === "assistant") {
        if (typeof message.provider === "string" && typeof message.model === "string") {
          this.models.add(`${message.provider}/${message.model}`);
        }
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        this.metrics.finalText = content
          .filter((block) => block.type === "text")
          .map((block) => String(block.text ?? ""))
          .join("\n");
        this.metrics.stopReason =
          typeof message.stopReason === "string" ? message.stopReason : "missing";
        for (const block of content) {
          if (block.type !== "toolCall") continue;
          this.metrics.topLevelToolCalls++;
          if (block.name === "codemode") this.metrics.codemodeCalls++;
        }
      } else if (message.role === "toolResult") {
        const nested = object(message.nestedCalls);
        if (Array.isArray(nested.calls)) this.metrics.nestedCalls += nested.calls.length;
        if (nested.complete === false) this.metrics.nestedCallsComplete = false;
        if (message.toolName === "codemode" && message.isError === true)
          this.metrics.codemodeFailures++;
      }
    } else if (event.type === "tool_execution_start") {
      const args = object(event.args);
      if (typeof args.command === "string") this.commands.add(args.command);
    } else if (event.type === "agent_settled") {
      this.metrics.settled = true;
      this.metrics.aborted = event.aborted === true;
    } else if (event.type === "compaction_end") {
      const result = object(event.result);
      if (result.usage) this.usageEntries.push({ type: "compaction", usage: result.usage });
    } else if (event.type === "entry_appended") {
      const entry = object(event.entry);
      if (entry.type === "usage") this.usageEntries.push(entry);
    }
  }
}

export interface ScoredRun {
  model: string;
  arm: string;
  task: string;
  passed: boolean;
  wallMs: number;
  metrics: RunMetrics;
}

export interface SummaryRow {
  model: string;
  arm: string;
  task: string;
  runs: number;
  passed: number;
  passRate: number;
  medianTokens: number;
  medianCost: number;
  medianWallMs: number;
  medianToolCalls: number;
  medianNestedCalls: number;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? (values[middle] ?? 0)
    : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

export function aggregateRuns(runs: readonly ScoredRun[], perTask = false): SummaryRow[] {
  const groups = new Map<string, ScoredRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.model, run.arm, perTask ? run.task : "all"]);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0];
      if (!first) throw new Error("Cannot summarize an empty group");
      const passed = group.filter((run) => run.passed).length;
      return {
        model: first.model,
        arm: first.arm,
        task: perTask ? first.task : "all",
        runs: group.length,
        passed,
        passRate: passed / group.length,
        medianTokens: median(group.map((run) => run.metrics.totalTokens)),
        medianCost: median(group.map((run) => run.metrics.cost)),
        medianWallMs: median(group.map((run) => run.wallMs)),
        medianToolCalls: median(group.map((run) => run.metrics.topLevelToolCalls)),
        medianNestedCalls: median(group.map((run) => run.metrics.nestedCalls)),
      };
    })
    .sort((a, b) => `${a.model}/${a.arm}/${a.task}`.localeCompare(`${b.model}/${b.arm}/${b.task}`));
}
