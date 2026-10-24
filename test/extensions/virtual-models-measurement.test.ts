import {
  type ClassifierApi,
  type ClassifierModel,
  type ClassifierResult,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractProviderUsage,
  installClassifierMeasurement,
} from "../../extensions/virtual-models/src/measurement.ts";
import { createMockContext } from "../mocks/context-mocks.ts";

beforeEach(() => vi.resetAllMocks());
describe("opt-in classifier measurement", () => {
  it("retains literal provider token fields without copying unrelated response data", () => {
    expect(
      extractProviderUsage({
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 4, secret: "omit" },
            apiKey: "omit",
          },
          output: "omit",
        },
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
    });
    expect(extractProviderUsage({ usage: null })).toBeUndefined();
    expect(extractProviderUsage({ message: { usage: { input_tokens: 3 } } })).toEqual({
      input_tokens: 3,
    });
  });
  it("records all registry classifier calls once and preserves their exact results and options", async () => {
    const registry = createMockContext().modelRegistry;
    const result: ClassifierResult = {
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-latest",
      timestamp: 1,
      stopReason: "stop",
      answers: {},
      usage: { ...fauxAssistantMessage("").usage, input: 5, output: 1, totalTokens: 6 },
    };
    const original = registry.classify.mockResolvedValue(result);
    const record = vi.fn(async () => "call-1");
    const installed = new WeakSet<object>();
    installClassifierMeasurement(registry, installed, record);
    installClassifierMeasurement(registry, installed, record);
    const model: ClassifierModel<ClassifierApi> = {
      type: "classifier",
      baseUrl: "https://test.invalid",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      id: "jev-latest",
      provider: "typesafe",
      name: "Jev",
      api: "typesafe-system-one",
      input: ["text" as const],
      contextWindow: 64000,
    };
    const context = { state: {}, questions: {} };
    const options = { maxRetries: 0 };
    expect(await registry.classify(model, context, options)).toBe(result);
    expect(original).toHaveBeenCalledWith(model, context, options);
    expect(original).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenNthCalledWith(
      1,
      "classifier_start",
      expect.objectContaining({ provider: "typesafe", model: "jev-latest" }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      "classifier_end",
      expect.objectContaining({ callId: "call-1", usage: result.usage, stopReason: "stop" }),
    );
  });
});
