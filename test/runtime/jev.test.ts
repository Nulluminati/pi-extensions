import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";

const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

async function runtimeTool(classify = vi.fn()) {
  const { loadExtensions } = await import(
    pathToFileURL(resolve(agentDist, "core/extensions/loader.js")).href
  );
  const loaded = await loadExtensions([resolve("extensions/jev/jev.ts")], process.cwd());
  expect(loaded.errors).toEqual([]);
  const registered = loaded.extensions[0].tools.get("jev");
  expect(registered).toBeDefined();
  const { wrapRegisteredTool } = await import(
    pathToFileURL(resolve(agentDist, "core/extensions/wrapper.js")).href
  );
  const model = { provider: "typesafe", id: "jev-latest" };
  const ctx = {
    mode: "json",
    hasUI: false,
    modelRegistry: { findOfType: vi.fn(() => model), classify },
  };
  const tool = wrapRegisteredTool(registered, { createToolContext: () => ctx });
  const agentCoreManifest = createRequire(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).resolve("@earendil-works/pi-agent-core/package.json");
  const { runToolCall } = await import(
    pathToFileURL(resolve(dirname(agentCoreManifest), "dist/index.js")).href
  );
  const call = (args: unknown) =>
    runToolCall(
      { type: "toolCall", id: "jev-runtime", name: "jev", arguments: args },
      {
        tools: [tool],
        context: { messages: [], tools: [tool] },
        assistantMessage: { role: "assistant", content: [], timestamp: 0 },
      },
    );
  return { call, definition: registered.definition, ctx };
}

const questions = {
  route: {
    type: "choice",
    instructions: "Which route fits?",
    criteria: { finish: "All tests passed", investigate: "Some tests failed" },
  },
  quality: {
    type: "score",
    instructions: "How complete is the evidence?",
    criteria: ["No result", "Partial result", "Full result"],
  },
  passed: {
    type: "bool",
    instructions: "Did every test pass?",
    criteria: { true: "All passed", false: "Some failed" },
  },
};

const answers = {
  route: {
    type: "choice",
    choice: "investigate",
    probabilities: { finish: 0, investigate: 1 },
    confidence: 1,
  },
  quality: { type: "score", score: 2, confidence: 0.9 },
  passed: { type: "bool", probability: 0 },
};

// The real loader and agent pipeline run offline. No provider credentials or network calls are needed.
describe("real Pi Jev tool contract", () => {
  it("returns validated structured judgments and usage through the real pipeline", async () => {
    const usage = {
      input: 200,
      output: 40,
      totalTokens: 240,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const classify = vi.fn(async () => ({
      provider: "typesafe",
      model: "jev-1.13.0",
      stopReason: "stop",
      answers,
      usage,
    }));
    const { call, definition } = await runtimeTool(classify);
    const outcome = await call({ state: { log: "2 passed, 1 failed" }, questions });
    expect(outcome.isError).toBe(false);
    expect(classify).toHaveBeenCalledWith(
      { provider: "typesafe", id: "jev-latest" },
      { state: { log: "2 passed, 1 failed" }, questions },
      expect.objectContaining({ timeoutMs: 10_000, maxRetries: 0 }),
    );
    expect(outcome.result.structuredContent).toEqual({
      status: "ok",
      provider: "typesafe",
      model: "jev-1.13.0",
      answers,
      usage,
    });
    expect(Check(definition.outputSchema, outcome.result.structuredContent)).toBe(true);
    expect(outcome.result.usage).toEqual(usage);
  });

  it("maps bool to Noul and parses raw System One answers with Pi's real adapter", async () => {
    const aiDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
    const { classify: classifySystemOne } = await import(
      pathToFileURL(resolve(aiDist, "api/typesafe-system-one.js")).href
    );
    const fetch = vi.fn(
      async (_url: URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              ...answers,
              passed: { type: "noul", noul: 0 },
              quality: {
                ...answers.quality,
                legend: { "0": "No result", "1": "Partial result", "2": "Full result" },
                probabilities: { "0": 0, "1": 0, "2": 1 },
              },
            },
            usage: { input_tokens: 200, output_tokens: 40 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const classify = vi.fn(
      async (
        model: { provider: string; id: string },
        context: ClassifierContext,
        options: Record<string, unknown>,
      ) =>
        classifySystemOne(
          {
            ...model,
            api: "typesafe-system-one",
            baseUrl: "https://api.typesafe.invalid/v1",
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          context,
          { ...options, apiKey: "fixture-key", fetch },
        ),
    );
    const { call } = await runtimeTool(classify);
    const outcome = await call({ state: { log: "2 passed, 1 failed" }, questions });
    expect(outcome.isError).toBe(false);
    expect(outcome.result.structuredContent.answers).toEqual(answers);
    expect(outcome.result.usage).toMatchObject({ input: 200, output: 40, totalTokens: 240 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(request).toEqual({
      model: "jev-latest",
      state: { log: "2 passed, 1 failed" },
      questions: { ...questions, passed: { ...questions.passed, type: "noul" } },
    });
  });

  it("marks classifier failures as real tool errors while preserving structured data", async () => {
    const { call, definition } = await runtimeTool(
      vi.fn(async () => ({
        provider: "typesafe",
        model: "jev-latest",
        stopReason: "error",
        answers: {},
        errorMessage: "No TypeSafe credentials",
      })),
    );
    const outcome = await call({ state: {}, questions });
    expect(outcome.isError).toBe(true);
    expect(outcome.result.structuredContent).toEqual({
      status: "error",
      error: "No TypeSafe credentials",
    });
    expect(Check(definition.outputSchema, outcome.result.structuredContent)).toBe(true);
  });

  it("rejects malformed parameters through real schema validation without inference", async () => {
    const classify = vi.fn();
    const { call } = await runtimeTool(classify);
    for (const args of [
      { state: "not an object", questions },
      { state: {}, questions: {} },
      {
        state: {},
        questions: { broken: { type: "score", instructions: "Rate", criteria: ["Only"] } },
      },
    ]) {
      const outcome = await call(args);
      expect(outcome.isError).toBe(true);
    }
    expect(classify).not.toHaveBeenCalled();
  });
});
