import { describe, expect, it } from "vitest";
import {
  classifierUsage,
  EventLedger,
  normalizeUsage,
  routeUsage,
  sumUsage,
} from "../../scripts/virtual-models-eval/ledger.ts";

const usage = { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, totalTokens: 19 };
const message = (timestamp = 1, extra: object = {}) => ({
  role: "assistant",
  provider: "zai",
  model: "glm-5.3-flash",
  timestamp,
  stopReason: "stop",
  content: [{ type: "text", text: "done" }],
  usage,
  ...extra,
});
const line = (event: unknown) => `${JSON.stringify(event)}\n`;

describe("pilot token accounting", () => {
  it("sums normalized input, output, and both cache categories without reusing provider totals", () => {
    expect(normalizeUsage({ ...usage, totalTokens: 99 })).toEqual({
      input: 10,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      aggregate: 19,
      providerTotal: 99,
    });
    expect(normalizeUsage({ input: "10", output: "3", totalTokens: "13" }).aggregate).toBe(13);
  });
  it("handles inclusive OpenAI prompt usage and exclusive Anthropic cache fields", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
        total_tokens: 13,
      }),
    ).toMatchObject({
      input: 6,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      aggregate: 13,
      providerTotal: 13,
    });
    expect(
      normalizeUsage({
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      }),
    ).toMatchObject({ aggregate: 19, providerTotal: null });
  });
  it("marks missing, partial, negative, and nonfinite usage unknown rather than zero", () => {
    for (const value of [
      undefined,
      {},
      { input: 10 },
      { input: -1, output: 3 },
      { input: Infinity, output: 3 },
    ])
      expect(normalizeUsage(value).aggregate).toBeNull();
    expect(sumUsage([normalizeUsage(usage), normalizeUsage(undefined)]).aggregate).toBeNull();
    expect(sumUsage([]).aggregate).toBe(0);
  });
  it("counts finalized calls once, ignores stream updates and agent rollups, and includes failed attempts", () => {
    const ledger = new EventLedger();
    ledger.push(line({ type: "message_update", message: message() }));
    ledger.push(line({ type: "message_end", message: message() }));
    ledger.push(line({ type: "message_end", message: message() }));
    ledger.push(line({ type: "agent_end", messages: [message()] }));
    ledger.push(
      line({
        type: "message_end",
        message: message(2, { stopReason: "error", errorMessage: "overloaded" }),
      }),
    );
    expect(ledger.finish()).toMatchObject({
      usage: { aggregate: 38 },
      calls: 2,
      errors: ["overloaded"],
    });
  });
  it("keeps distinct calls with identical provider timestamps separate", () => {
    const ledger = new EventLedger();
    for (let i = 0; i < 2; i++) {
      ledger.push(line({ type: "message_start", message: message() }));
      ledger.push(line({ type: "message_end", message: message() }));
    }
    expect(ledger.finish()).toMatchObject({ calls: 2, usage: { aggregate: 38 }, unknownCalls: 0 });
  });

  it("records per-call physical identity and effective thinking without inventing missing levels", () => {
    const ledger = new EventLedger();
    ledger.push(line({ type: "message_end", message: message(1, { thinkingLevel: "high" }) }));
    expect(ledger.finish().dispatches).toEqual([
      expect.objectContaining({
        model: "glm-5.3-flash",
        provider: "zai",
        thinkingLevel: "high",
        usage: expect.objectContaining({ aggregate: 19 }),
      }),
    ]);
  });

  it("records parent tool names so worker comparisons cannot include parent repairs", () => {
    const ledger = new EventLedger();
    ledger.push(line({ type: "tool_execution_start", toolName: "edit", args: {} }));
    expect(ledger.finish().tools).toEqual(["edit"]);
  });

  it("counts parent tool usage once without traversing nested details or worker rollups", () => {
    const ledger = new EventLedger();
    ledger.push(
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "codemode",
          toolCallId: "a",
          usage,
          details: { nestedUsage: usage },
        },
      }),
    );
    ledger.push(
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "workers",
          toolCallId: "b",
          usage,
          details: { usage },
        },
      }),
    );
    expect(ledger.finish().usage.aggregate).toBe(19);
  });
  it("retains unknown usage on interrupted streams and records retries and compaction", () => {
    const ledger = new EventLedger();
    ledger.push(line({ type: "message_start", message: message() }));
    ledger.push(line({ type: "auto_retry_start" }));
    ledger.push(line({ type: "auto_compaction_end", result: { usage } }));
    ledger.push('{"type":"message_end"');
    expect(ledger.finish()).toMatchObject({
      usage: { aggregate: null },
      unknownCalls: 1,
      retries: 1,
      compactions: 1,
      partialLine: true,
    });
  });
  it("distinguishes unused classifiers from attempted calls with missing usage", () => {
    expect(
      routeUsage([{ routeId: "a", classifier: { status: "unavailable", attempted: false } }])
        .aggregate,
    ).toBe(0);
    expect(
      routeUsage([{ routeId: "a", classifier: { status: "timeout", attempted: true } }]).aggregate,
    ).toBeNull();
    expect(
      routeUsage([
        { routeId: "a", classifier: { status: "ok", attempted: true, usage } },
        { routeId: "a", classifier: { status: "ok", attempted: true, usage } },
      ]).aggregate,
    ).toBe(19);
  });
  it("counts runtime classifier starts and ends once without adding duplicate router usage", () => {
    const events = [
      { type: "classifier_start", routeId: "c1" },
      { type: "classifier_end", callId: "c1", usage },
      { type: "classifier_end", callId: "c1", usage },
      { type: "route", classifier: { attempted: true, usage } },
    ];
    expect(classifierUsage(events).aggregate).toBe(19);
    expect(
      classifierUsage([...events, { type: "classifier_start", routeId: "c2" }]).aggregate,
    ).toBeNull();
  });

  it.each(["error", "aborted"])(
    "does not treat SDK %s placeholders as reported zero-token usage",
    (stopReason) => {
      const ledger = new EventLedger();
      ledger.push(
        line({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "p",
            model: "m",
            stopReason,
            errorMessage: "Endpoint unavailable",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            content: [],
          },
        }),
      );
      expect(ledger.finish().usage.aggregate).toBeNull();
      expect(ledger.finish().unknownCalls).toBe(1);
      const partial = new EventLedger();
      partial.push(
        line({
          type: "message_end",
          message: { role: "assistant", provider: "p", model: "m", stopReason, usage, content: [] },
        }),
      );
      expect(partial.finish().usage.aggregate).toBe(19);
    },
  );

  it("captures actual assertion failures but does not accept a test-runner startup error as a test failure", () => {
    const ledger = new EventLedger();
    ledger.push(
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "bad",
          isError: true,
          content: [{ type: "text", text: "failed to load config: Cannot find package vitest" }],
        },
      }),
    );
    expect(ledger.finish().assertionFailures).toEqual([]);
    const text = "FAIL pilot fixed precision\nAssertionError: expected '1.0k' to be '1k'";
    ledger.push(
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "expected",
          isError: true,
          content: [{ type: "text", text }],
        },
      }),
    );
    expect(ledger.finish().assertionFailures).toEqual([text]);
  });

  it("handles split JSON lines without parsing carriage returns as record separators", () => {
    const ledger = new EventLedger();
    const event = line({ type: "message_end", message: message() });
    ledger.push(event.slice(0, 35));
    ledger.push(event.slice(35));
    expect(ledger.finish()).toMatchObject({
      calls: 1,
      usage: { aggregate: 19 },
      finalText: "done",
    });
  });
});
