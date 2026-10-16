import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult, ClassifierAnswer, ClassifierResult } from "pi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import jevExtension from "../../extensions/jev/jev.ts";
import * as jsonAtomic from "../../lib/json-atomic.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../lib/json-atomic.ts", { spy: true });

const questions = {
  supported: {
    type: "bool",
    instructions: "Does `log` show that all tests passed?",
    criteria: { true: "All tests passed", false: "A failure or no result" },
  },
  route: {
    type: "choice",
    instructions: "Which workflow fits the evidence?",
    criteria: { finish: "Tests passed", investigate: "Tests failed or evidence is missing" },
  },
  quality: {
    type: "score",
    instructions: "How complete is the test evidence?",
    criteria: ["No test result", "Partial result", "Full result"],
  },
} as const;

const answers = {
  supported: { type: "bool", probability: 0 },
  route: {
    type: "choice",
    choice: "investigate",
    probabilities: { finish: 0.1, investigate: 0.9 },
    confidence: 0.7,
  },
  quality: { type: "score", score: 1.5, confidence: 0 },
} satisfies Record<string, ClassifierAnswer>;

const usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-1.13.0",
    answers,
    usage,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

async function setup() {
  const pi = createMockPi();
  const ctx = createMockContext();
  const model = { ...ctx.model, provider: "typesafe", id: "jev-latest" };
  ctx.modelRegistry.findOfType.mockReturnValue(model);
  ctx.modelRegistry.classify.mockResolvedValue(response());
  await jevExtension(pi);
  return { pi, ctx, model, tool: pi.registerTool.mock.calls[0][0] };
}

function expectFailure(result: AgentToolResult, message: RegExp) {
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ status: "error", error: expect.stringMatching(message) });
  expect(result.structuredContent).toEqual(result.details);
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
  expect(result.terminate).toBeUndefined();
}

describe("jev extension", () => {
  beforeEach(() => vi.resetAllMocks());

  it("registers one advisory tool without commands, hooks, or session access", async () => {
    const { pi, tool } = await setup();
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(tool.name).toBe("jev");
    expect(tool.outputSchema).toBeDefined();
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tool.promptGuidelines.join(" ")).toMatch(/supplied|evidence/i);
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("batches all question types, preserves uncertainty, and forwards usage", async () => {
    const { ctx, model, tool } = await setup();
    const state = { log: "2 passed, 1 failed", metadata: [true, null, 3] };
    const signal = new AbortController().signal;
    const result = await tool.execute("call", { state, questions }, signal, undefined, ctx);
    expect(ctx.modelRegistry.findOfType).toHaveBeenCalledWith(
      "classifier",
      "typesafe",
      "jev-latest",
    );
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
    expect(ctx.modelRegistry.classify).toHaveBeenCalledWith(
      model,
      { state, questions },
      {
        signal,
        timeoutMs: 10_000,
        maxRetries: 0,
      },
    );
    expect(result.details).toEqual({
      status: "ok",
      provider: "typesafe",
      model: "jev-1.13.0",
      answers,
      usage,
    });
    expect(result.structuredContent).toEqual(result.details);
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(result.usage).toEqual(usage);
    expect(result.isError).toBeUndefined();
    expect(result.terminate).toBeUndefined();
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("accepts a zero score and exact probability endpoints", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockResolvedValue(
      response({
        answers: {
          ...answers,
          quality: { type: "score", score: 0, confidence: 1 },
          supported: { type: "bool", probability: 1 },
        },
      }),
    );
    const result = await tool.execute("zero", { state: {}, questions }, undefined, undefined, ctx);
    expect(result.details.status).toBe("ok");
    expect(result.details.answers.quality.score).toBe(0);
  });

  it("uses an explicit provider/model without fallback or changing the chat model", async () => {
    const { pi, ctx, tool } = await setup();
    await tool.execute(
      "model",
      { state: {}, questions, model: "openrouter/typesafe/jev-1.13" },
      undefined,
      undefined,
      ctx,
    );
    expect(ctx.modelRegistry.findOfType).toHaveBeenCalledWith(
      "classifier",
      "openrouter",
      "typesafe/jev-1.13",
    );
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("works without UI and falls back to the current operation signal", async () => {
    const { ctx, tool } = await setup();
    ctx.hasUI = false;
    ctx.mode = "json";
    const signal = new AbortController().signal;
    await tool.execute("headless", { state: {}, questions }, undefined, undefined, {
      ...ctx,
      signal,
    });
    expect(ctx.modelRegistry.classify).toHaveBeenCalledWith(
      expect.any(Object),
      { state: {}, questions },
      expect.objectContaining({ signal }),
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("omits usage when the provider does not report it", async () => {
    const { ctx, tool } = await setup();
    const resultWithoutUsage = response();
    delete resultWithoutUsage.usage;
    ctx.modelRegistry.classify.mockResolvedValue(resultWithoutUsage);
    const result = await tool.execute("usage", { state: {}, questions }, undefined, undefined, ctx);
    expect(result.details).not.toHaveProperty("usage");
    expect(result.usage).toBeUndefined();
  });

  it("reports missing classifiers without trying another provider", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.findOfType.mockReturnValue(undefined);
    const result = await tool.execute(
      "missing",
      { state: {}, questions },
      undefined,
      undefined,
      ctx,
    );
    expectFailure(result, /classifier.*typesafe\/jev-latest.*unavailable/i);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted"] as const)(
    "reports provider %s without returning judgments",
    async (stopReason) => {
      const { ctx, tool } = await setup();
      ctx.modelRegistry.classify.mockResolvedValue(
        response({ stopReason, errorMessage: "Service unavailable" }),
      );
      const result = await tool.execute(
        "service",
        { state: {}, questions },
        undefined,
        undefined,
        ctx,
      );
      expectFailure(result, /Service unavailable/);
      expect(result.details).not.toHaveProperty("answers");
      expect(result.usage).toEqual(usage);
    },
  );

  it("reports a provider failure without a message", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockResolvedValue(response({ stopReason: "error" }));
    const result = await tool.execute(
      "service",
      { state: {}, questions },
      undefined,
      undefined,
      ctx,
    );
    expectFailure(result, /failed/i);
  });

  it("reports provider cancellation without a message", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockResolvedValue(response({ stopReason: "aborted" }));
    const result = await tool.execute(
      "provider-abort",
      { state: {}, questions },
      undefined,
      undefined,
      ctx,
    );
    expectFailure(result, /cancelled/i);
    expect(result.details).not.toHaveProperty("answers");
    expect(result.usage).toEqual(usage);
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
  });

  it("reports thrown registry failures", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockRejectedValue(new Error("Connection failed"));
    const result = await tool.execute("throw", { state: {}, questions }, undefined, undefined, ctx);
    expectFailure(result, /Connection failed/);
  });

  it("does not send an already-cancelled request", async () => {
    const { ctx, tool } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      "abort",
      { state: {}, questions },
      controller.signal,
      undefined,
      ctx,
    );
    expectFailure(result, /cancelled/i);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("does not accept a result after cancellation", async () => {
    const { ctx, tool } = await setup();
    const controller = new AbortController();
    ctx.modelRegistry.classify.mockImplementation(async () => {
      controller.abort();
      return response();
    });
    const result = await tool.execute(
      "abort-late",
      { state: {}, questions },
      controller.signal,
      undefined,
      ctx,
    );
    expectFailure(result, /cancelled/i);
    expect(result.usage).toEqual(usage);
  });

  it.each([
    ["missing state", { questions }],
    ["null state", { state: null, questions }],
    ["string state", { state: "text", questions }],
    ["array state", { state: [], questions }],
    ["non-finite state", { state: { n: Number.NaN }, questions }],
    ["undefined value", { state: { n: undefined }, questions }],
    ["empty questions", { state: {}, questions: {} }],
    ["null questions", { state: {}, questions: null }],
    [
      "too many questions",
      {
        state: {},
        questions: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`q${i}`, questions.supported]),
        ),
      },
    ],
    ["blank id", { state: {}, questions: { " ": questions.supported } }],
    ["unknown type", { state: {}, questions: { a: { ...questions.supported, type: "noul" } } }],
    [
      "blank instructions",
      { state: {}, questions: { a: { ...questions.supported, instructions: " " } } },
    ],
    [
      "missing bool criteria",
      { state: {}, questions: { a: { type: "bool", instructions: "Ready?" } } },
    ],
    [
      "extra bool criteria",
      {
        state: {},
        questions: {
          a: { ...questions.supported, criteria: { true: "Yes", false: "No", other: "Maybe" } },
        },
      },
    ],
    [
      "single choice",
      { state: {}, questions: { a: { ...questions.route, criteria: { one: "Only one" } } } },
    ],
    [
      "too many choices",
      {
        state: {},
        questions: {
          a: {
            ...questions.route,
            criteria: Object.fromEntries(
              Array.from({ length: 256 }, (_, i) => [`c${i}`, "Choice"]),
            ),
          },
        },
      },
    ],
    [
      "blank choice",
      {
        state: {},
        questions: { a: { ...questions.route, criteria: { " ": "Blank", other: "Other" } } },
      },
    ],
    [
      "blank criterion",
      { state: {}, questions: { a: { ...questions.route, criteria: { a: " ", b: "Other" } } } },
    ],
    [
      "one score level",
      { state: {}, questions: { a: { ...questions.quality, criteria: ["Only"] } } },
    ],
    [
      "too many score levels",
      { state: {}, questions: { a: { ...questions.quality, criteria: Array(11).fill("Level") } } },
    ],
    [
      "wrong score criteria",
      { state: {}, questions: { a: { ...questions.quality, criteria: { a: "Level" } } } },
    ],
    ["invalid model", { state: {}, questions, model: "jev-latest" }],
    ["empty model provider", { state: {}, questions, model: "/jev-latest" }],
    ["empty model id", { state: {}, questions, model: "typesafe/" }],
  ])("rejects %s before model lookup", async (_label, params) => {
    const { ctx, tool } = await setup();
    const result = await tool.execute("invalid", params, undefined, undefined, ctx);
    expectFailure(result, /state|questions|criteria|instructions|model/i);
    expect(ctx.modelRegistry.findOfType).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("accepts the maximum question, choice, and score counts", async () => {
    const { ctx, tool } = await setup();
    const criteria = Object.fromEntries(
      Array.from({ length: 255 }, (_, i) => [`c${i}`, `Option ${i}`]),
    );
    const batch = {
      ...Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`q${i}`, questions.supported])),
      route: { ...questions.route, criteria },
      quality: {
        ...questions.quality,
        criteria: Array.from({ length: 10 }, (_, i) => `Level ${i}`),
      },
    };
    const expectedAnswers = {
      ...Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`q${i}`, answers.supported])),
      route: {
        type: "choice" as const,
        choice: "c0",
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key) => [key, key === "c0" ? 1 : 0]),
        ),
      },
      quality: { type: "score" as const, score: 9, confidence: 1 },
    };
    ctx.modelRegistry.classify.mockResolvedValue(response({ answers: expectedAnswers }));
    const result = await tool.execute(
      "limits",
      { state: {}, questions: batch },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).toMatchObject({ status: "ok", answers: expectedAnswers });
    expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
  });

  it.each([65_536, 65_537])("enforces the exact %i-byte input boundary", async (bytes) => {
    const { ctx, tool } = await setup();
    const selectedQuestions = { supported: questions.supported };
    const state = { text: "" };
    const overhead = Buffer.byteLength(
      JSON.stringify({ state, questions: selectedQuestions }),
      "utf8",
    );
    state.text = "a".repeat(bytes - overhead);
    ctx.modelRegistry.classify.mockResolvedValue(
      response({ answers: { supported: answers.supported } }),
    );
    const result = await tool.execute(
      "bytes",
      { state, questions: selectedQuestions },
      undefined,
      undefined,
      ctx,
    );
    if (bytes === 65_536) {
      expect(result.details.status).toBe("ok");
      expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
    } else {
      expectFailure(result, /65.?536|64 KiB/);
      expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
    }
  });

  it("rejects cyclic and deeply nested state without serialization crashes", async () => {
    const { ctx, tool } = await setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) nested = { child: nested };
    for (const state of [cyclic, nested]) {
      const result = await tool.execute("deep", { state, questions }, undefined, undefined, ctx);
      expectFailure(result, /state|nest|JSON/i);
    }
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 input without truncation", async () => {
    const { ctx, tool } = await setup();
    const state = { text: "🦔".repeat(17_000) };
    const result = await tool.execute("large", { state, questions }, undefined, undefined, ctx);
    expectFailure(result, /65.?536|64 KiB/);
    expect(ctx.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it.each([
    ["missing answer", { supported: answers.supported, route: answers.route }],
    ["extra answer", { ...answers, extra: answers.supported }],
    ["null envelope", null],
    ["wrong type", { ...answers, supported: answers.quality }],
    ["out-of-range bool", { ...answers, supported: { type: "bool", probability: 1.1 } }],
    ["non-finite bool", { ...answers, supported: { type: "bool", probability: Number.NaN } }],
    ["unknown choice", { ...answers, route: { ...answers.route, choice: "unknown" } }],
    [
      "missing distribution key",
      { ...answers, route: { ...answers.route, probabilities: { investigate: 1 } } },
    ],
    [
      "extra distribution key",
      {
        ...answers,
        route: { ...answers.route, probabilities: { ...answers.route.probabilities, other: 0 } },
      },
    ],
    [
      "non-normalized distribution",
      { ...answers, route: { ...answers.route, probabilities: { finish: 0.1, investigate: 0.1 } } },
    ],
    ["wrong winner", { ...answers, route: { ...answers.route, choice: "finish" } }],
    ["missing confidence", { ...answers, quality: { type: "score", score: 1 } }],
    ["out-of-range confidence", { ...answers, quality: { ...answers.quality, confidence: -1 } }],
    ["out-of-range score", { ...answers, quality: { ...answers.quality, score: 3 } }],
    [
      "non-finite score",
      { ...answers, quality: { ...answers.quality, score: Number.POSITIVE_INFINITY } },
    ],
  ])("reports %s as invalid output, not uncertainty", async (_label, invalidAnswers) => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockResolvedValue({
      ...response(),
      answers: invalidAnswers,
    } as ClassifierResult);
    const result = await tool.execute(
      "invalid-answer",
      { state: {}, questions },
      undefined,
      undefined,
      ctx,
    );
    expectFailure(result, /invalid.*answer/i);
    expect(result.details).not.toHaveProperty("answers");
    expect(result.usage).toEqual(usage);
  });

  it("accepts tied choices and rounded distributions", async () => {
    const { ctx, tool } = await setup();
    ctx.modelRegistry.classify.mockResolvedValue(
      response({
        answers: {
          ...answers,
          route: {
            type: "choice",
            choice: "finish",
            probabilities: { finish: 0.5, investigate: 0.5 },
            confidence: 0,
          },
        },
      }),
    );
    const tied = await tool.execute("tie", { state: {}, questions }, undefined, undefined, ctx);
    expect(tied.details.status).toBe("ok");
    ctx.modelRegistry.classify.mockResolvedValue(
      response({
        answers: {
          ...answers,
          route: { ...answers.route, probabilities: { finish: 0.101, investigate: 0.9 } },
        },
      }),
    );
    const rounded = await tool.execute(
      "rounding",
      { state: {}, questions },
      undefined,
      undefined,
      ctx,
    );
    expect(rounded.details.status).toBe("ok");
  });

  it.each(["directory creation", "file writing", "cleanup"])(
    "preserves large validated answers when %s fails",
    async (failure) => {
      const { ctx, tool } = await setup();
      const id = "q".repeat(55_000);
      const directory = join(tmpdir(), "pi-jev-storage-test");
      const createDirectory = vi.mocked(fs.mkdtemp);
      const writeResult = vi.mocked(jsonAtomic.writeJsonAtomic);
      const removeDirectory = vi.mocked(fs.rm);
      if (failure === "directory creation") {
        createDirectory.mockRejectedValueOnce(new Error("Temporary directory unavailable"));
      } else {
        createDirectory.mockResolvedValueOnce(directory);
        writeResult.mockRejectedValueOnce(new Error("Temporary result write failed"));
        if (failure === "cleanup") {
          removeDirectory.mockRejectedValueOnce(new Error("Temporary directory cleanup failed"));
        } else {
          removeDirectory.mockResolvedValueOnce(undefined);
        }
      }
      ctx.modelRegistry.classify.mockResolvedValue(
        response({ answers: { [id]: answers.supported } }),
      );
      const result = await tool.execute(
        "storage-failure",
        { state: {}, questions: { [id]: questions.supported } },
        undefined,
        undefined,
        ctx,
      );

      expect(result.details.status).toBe("ok");
      expect(result.details.provider).toBe("typesafe");
      expect(result.details.model).toBe("jev-1.13.0");
      expect(result.details.answers[id]).toEqual(answers.supported);
      expect(result.details.usage).toEqual(usage);
      expect(result.details).not.toHaveProperty("error");
      expect(result.details).not.toHaveProperty("fullResultPath");
      expect(result.structuredContent).toEqual(result.details);
      expect(result.usage).toEqual(usage);
      expect(result.isError).toBeUndefined();
      expect(result.terminate).toBeUndefined();
      expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThan(51_200);
      const notice = JSON.parse(result.content[0].text);
      expect(notice.status).toBe("ok");
      expect(notice.message).toMatch(/could not.*(?:save|write)/i);
      expect(notice).not.toHaveProperty("fullResultPath");
      expect(ctx.modelRegistry.classify).toHaveBeenCalledTimes(1);
      expect(createDirectory).toHaveBeenCalledWith(join(tmpdir(), "pi-jev-"));
      if (failure === "directory creation") {
        expect(writeResult).not.toHaveBeenCalled();
        expect(removeDirectory).not.toHaveBeenCalled();
      } else {
        expect(writeResult).toHaveBeenCalledWith(
          join(directory, "result.json"),
          expect.objectContaining({ status: "ok", usage }),
          { mode: 0o600 },
        );
        expect(removeDirectory).toHaveBeenCalledWith(directory, { recursive: true, force: true });
        if (failure === "cleanup") expect(notice.message).toMatch(/cleanup/i);
      }
    },
  );

  it("keeps large answers out of model context and saves the complete result privately", async () => {
    const { ctx, tool } = await setup();
    const id = "q".repeat(55_000);
    ctx.modelRegistry.classify.mockResolvedValue(
      response({ answers: { [id]: answers.supported } }),
    );
    const result = await tool.execute(
      "large-output",
      {
        state: {},
        questions: { [id]: questions.supported },
      },
      undefined,
      undefined,
      ctx,
    );
    const path = result.details.fullResultPath;
    expect(path).toBeTypeOf("string");
    try {
      expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThan(51_200);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        status: "ok",
        fullResultPath: path,
      });
      expect(JSON.parse(await fs.readFile(path, "utf8"))).toMatchObject({
        status: "ok",
        answers: { [id]: answers.supported },
        usage,
      });
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
      expect(result.structuredContent).toEqual(result.details);
      expect(result.details.answers[id]).toEqual(answers.supported);
      expect(result.usage).toEqual(usage);
    } finally {
      await fs.rm(dirname(path), { recursive: true, force: true });
    }
  });

  it("preserves caller-owned ids such as __proto__ without prototype mutation", async () => {
    const { ctx, tool } = await setup();
    const specialQuestions = JSON.parse(
      '{"__proto__":{"type":"bool","instructions":"Ready?","criteria":{"true":"Yes","false":"No"}}}',
    );
    const specialAnswers = JSON.parse('{"__proto__":{"type":"bool","probability":0.5}}');
    ctx.modelRegistry.classify.mockResolvedValue(response({ answers: specialAnswers }));
    const result = await tool.execute(
      "ids",
      { state: {}, questions: specialQuestions },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.answers).toEqual(specialAnswers);
    expect(Object.hasOwn(result.details.answers, "__proto__")).toBe(true);
  });
});
