import { describe, expect, it } from "vitest";
import { sumSessionUsage } from "../../lib/session-usage.ts";

const usage = (overrides: Record<string, unknown> = {}) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 0 },
  ...overrides,
});

describe("sumSessionUsage", () => {
  it("sums assistant, toolResult, usage, compaction, and branch_summary entries", () => {
    const totals = sumSessionUsage([
      { type: "message", message: { role: "user", content: "hi" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: usage({
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 10,
            cost: { total: 0.01 },
          }),
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "done",
          toolName: "bash",
          usage: usage({ input: 100, output: 50, cost: { total: 1 } }),
        },
      },
      { type: "usage", usage: usage({ input: 5, cost: { total: 0.0001 } }) },
      { type: "compaction", usage: usage({ input: 7, cost: { total: 0.0002 } }) },
      { type: "branch_summary", usage: usage({ input: 9, cost: { total: 0.0003 } }) },
    ]);

    expect(totals.input).toBe(221);
    expect(totals.output).toBe(70);
    expect(totals.cacheRead).toBe(30);
    expect(totals.cacheWrite).toBe(10);
    expect(totals.totalTokens).toBe(331);
    expect(totals.cost).toBeCloseTo(1.0106, 10);
  });

  it("counts a $1 toolResult roll-up as input 100 / output 50", () => {
    const totals = sumSessionUsage([
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "ok",
          toolName: "bash",
          usage: usage({ input: 100, output: 50, cost: { total: 1 } }),
        },
      },
    ]);

    expect(totals).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: 1,
    });
  });

  it("does not recount nested codemode usage already rolled into the toolResult", () => {
    // Nested image/classifier/tool calls are not separate branch entries;
    // their usage is rolled into the top-level toolResult and must count once.
    const totals = sumSessionUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "running code" }],
          usage: usage({ input: 10, output: 5, cost: { total: 0.01 } }),
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "ok",
          toolName: "bash",
          usage: usage({ input: 100, output: 50, cost: { total: 1 } }),
          details: {
            calls: [
              { name: "image", usage: usage({ input: 100, output: 50, cost: { total: 1 } }) },
            ],
          },
        },
      },
    ]);

    expect(totals.input).toBe(110);
    expect(totals.output).toBe(55);
    expect(totals.cost).toBeCloseTo(1.01, 10);
  });

  it("skips toolResult messages without usage and non-object entries", () => {
    const totals = sumSessionUsage([
      null,
      "garbage",
      42,
      {
        type: "message",
        message: { role: "toolResult", content: "no usage here", toolName: "bash" },
      },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "compaction" },
      { type: "branch_summary" },
      { type: "usage" },
    ]);

    expect(totals).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    });
  });

  it("tolerates string numbers, numeric costs, and non-finite values", () => {
    const totals = sumSessionUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: "120",
            output: Number.NaN,
            cacheRead: Number.POSITIVE_INFINITY,
            cacheWrite: undefined,
            cost: 0.25,
          },
        },
      },
      { type: "usage", usage: { input: 8, output: "3", cost: { total: "0.5" } } },
    ]);

    expect(totals.input).toBe(128);
    expect(totals.output).toBe(3);
    expect(totals.cacheRead).toBe(0);
    expect(totals.cacheWrite).toBe(0);
    expect(totals.totalTokens).toBe(131);
    expect(totals.cost).toBeCloseTo(0.75, 10);
  });
});
