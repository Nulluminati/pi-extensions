import { describe, expect, it } from "vitest";
import type { ProviderChatModelConfig } from "../../lib/pi-types.ts";
import { formatProviderModelList } from "../../lib/provider-models.ts";

function makeModel(overrides: Partial<ProviderChatModelConfig> = {}): ProviderChatModelConfig {
  return {
    id: "test-model",
    name: "Test Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("formatProviderModelList", () => {
  it("returns a placeholder for an empty list", () => {
    expect(formatProviderModelList([])).toBe("No models available.");
  });

  it("formats one bullet line per model with caps and pricing", () => {
    const text = formatProviderModelList([makeModel()]);

    expect(text).toBe("  • test-model (tools) · in $1.00/out $2.00");
  });

  it("lists vision and reasoning caps before tools", () => {
    const text = formatProviderModelList([
      makeModel({ id: "big-model", reasoning: true, input: ["text", "image"] }),
    ]);

    expect(text).toBe("  • big-model (vision, reasoning, tools) · in $1.00/out $2.00");
  });

  it("renders fractional prices with two decimals", () => {
    const text = formatProviderModelList([
      makeModel({ cost: { input: 0.1, output: 1.256, cacheRead: 0, cacheWrite: 0 } }),
    ]);

    expect(text).toContain("in $0.10/out $1.26");
  });

  it("joins multiple models with newlines in list order", () => {
    const text = formatProviderModelList([
      makeModel({ id: "a-first" }),
      makeModel({ id: "b-second" }),
    ]);
    const lines = text.split("\n");

    expect(lines).toEqual([
      "  • a-first (tools) · in $1.00/out $2.00",
      "  • b-second (tools) · in $1.00/out $2.00",
    ]);
  });
});
