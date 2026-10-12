import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  Component,
  ExtensionContext,
  Theme,
  ToolRenderContext,
  ToolRenderResultOptions,
} from "pi";
import { afterEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../extensions/ask-user/ask-user.ts";
import {
  createQuestionnaireState,
  reduceQuestionnaire,
  toSubmittedAnswers,
} from "../../extensions/ask-user/src/dialog.ts";
import {
  type AskUserDetails,
  type AskUserQuestion,
  validateQuestions,
} from "../../extensions/ask-user/src/schema.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

vi.mock("typebox", () => ({
  Type: {
    Object: (properties: Record<string, unknown>) => ({ type: "object", properties }),
    String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
    Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", ...options }),
    Optional: (schema: Record<string, unknown>) => schema,
    Array: (items: unknown, options?: Record<string, unknown>) => ({
      type: "array",
      items,
      ...options,
    }),
  },
}));

afterEach(() => {
  vi.resetAllMocks();
});

const QUESTIONS: AskUserQuestion[] = [
  {
    id: "storage",
    header: "Storage",
    question: "Where should answers be stored?",
    context: "Answers must follow the active session branch.",
    options: [
      {
        value: "details",
        label: "Tool result details",
        description: "Stored with the tool result on the active branch.",
        recommended: true,
      },
      { value: "file", label: "Local file", description: "Stored outside the session." },
    ],
  },
  {
    id: "features",
    header: "Features",
    question: "Which interaction features should be included?",
    multiSelect: true,
    options: [
      { value: "review", label: "Review tab" },
      { value: "notes", label: "Answer notes" },
    ],
  },
];

describe("ask-user-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/ask-user");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = (await readdir(resolve(extensionDir, "src"))).filter((file) =>
        file.endsWith(".ts"),
      );

      expect(rootTypeScriptFiles).toEqual(["ask-user.ts"]);
      expect(sourceFiles.sort()).toEqual(["dialog-flow.ts", "dialog.ts", "result.ts", "schema.ts"]);
    });
  });

  it("registers a sequential ask_user tool with focused usage guidance", async () => {
    const pi = createMockPi();

    await askUserExtension(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = getTool(pi);
    expect(tool.name).toBe("ask_user");
    expect(tool.executionMode).toBe("sequential");
    // Codemode scripts must not be able to call ask_user; only the model does.
    expect(tool.exposure).toBe("model-only");
    expect(tool.promptSnippet).toContain("questions");
    expect(tool.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ask_user"),
        expect.stringContaining("one tool call"),
        expect.stringContaining("Call ask_user by itself"),
      ]),
    );
  });

  it("collects single-select, multi-select, and supplemental custom text in one TUI form", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    let initialRender = "";
    let secondQuestionRender = "";
    let customRender = "";
    let reviewRender = "";
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesQuestionnaireKey },
            resolve,
          );
          initialRender = component.render(80).join("\n");

          component.handleInput?.("\r");
          secondQuestionRender = component.render(80).join("\n");

          component.handleInput?.(" ");
          component.handleInput?.("\u001b[B");
          component.handleInput?.("\u001b[B");
          component.handleInput?.("\r");
          customRender = component.render(80).join("\n");
          for (const character of "CSV export") component.handleInput?.(character);
          component.handleInput?.("\r");

          reviewRender = component.render(80).join("\n");
          component.handleInput?.("\r");
        }),
    );
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx);

    expect(initialRender).toContain("Storage");
    expect(initialRender).toContain("Features");
    expect(initialRender).toContain("Review");
    expect(initialRender).toContain("Tool result details");
    expect(initialRender).toContain("Recommended");
    expect(secondQuestionRender).toContain("Which interaction features should be included?");
    expect(customRender).toContain("Add another answer");
    expect(reviewRender).toContain("Review your answers");
    expect(reviewRender).toContain("Review tab");
    expect(reviewRender).toContain("CSV export");
    expect(result.terminate).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Storage: Tool result details\nFeatures: Review tab; wrote: CSV export",
      },
    ]);
    expect(result.details).toEqual({
      version: 1,
      status: "submitted",
      answers: [
        { questionId: "storage", selectedValues: ["details"] },
        { questionId: "features", selectedValues: ["review"], customText: "CSV export" },
      ],
    });
  });

  it("supports freeform-only questions", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    let initialRender = "";
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesQuestionnaireKey },
            resolve,
          );
          initialRender = component.render(80).join("\n");
          for (const character of "Project Atlas") component.handleInput?.(character);
          component.handleInput?.("\r");
          component.handleInput?.("\r");
        }),
    );
    await askUserExtension(pi);

    const result = await executeTool(
      pi,
      {
        questions: [{ id: "name", header: "Name", question: "What should the project be called?" }],
      },
      ctx,
    );

    expect(initialRender).toContain("Your answer");
    expect(initialRender).not.toContain("Add another answer");
    expect(firstResultText(result)).toBe("Name: wrote: Project Atlas");
    expect(result.details).toEqual({
      version: 1,
      status: "submitted",
      answers: [{ questionId: "name", selectedValues: [], customText: "Project Atlas" }],
    });
  });

  it("preserves a freeform draft while tabbing forward and backward", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    let reviewRender = "";
    let restoredNotesRender = "";
    let previousQuestionRender = "";
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesQuestionnaireKey },
            resolve,
          );
          component.handleInput?.("\t");
          for (const character of "remember this note") component.handleInput?.(character);

          component.handleInput?.("\t");
          reviewRender = component.render(80).join("\n");

          component.handleInput?.("\u001b[9;2u");
          restoredNotesRender = component.render(80).join("\n");

          component.handleInput?.("\u001b[9;2u");
          previousQuestionRender = component.render(80).join("\n");
          component.handleInput?.("\u001b");
        }),
    );
    await askUserExtension(pi);

    await executeTool(
      pi,
      {
        questions: [
          QUESTIONS[0],
          { id: "notes", header: "Notes", question: "What should we remember?" },
        ],
      },
      ctx,
    );

    expect(reviewRender).toContain("Review your answers");
    expect(reviewRender).toContain("remember this note");
    expect(restoredNotesRender).toContain("Your answer");
    expect(restoredNotesRender).toContain("remember this note");
    expect(previousQuestionRender).toContain("Where should answers be stored?");
  });

  it("returns control to the user when the questionnaire is dismissed", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesQuestionnaireKey },
            resolve,
          );
          component.handleInput?.("\u001b");
        }),
    );
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx);

    expect(result).toEqual({
      content: [{ type: "text", text: "User dismissed the questionnaire." }],
      details: { version: 1, status: "dismissed", answers: [] },
      terminate: true,
    });
  });

  it("returns an aborted result when execution is already cancelled", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    const controller = new AbortController();
    controller.abort();
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx, controller.signal);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "Questionnaire aborted before it opened." }],
      details: { version: 1, status: "aborted", answers: [] },
      terminate: true,
    });
  });

  it("settles once when abort fires while the TUI is open", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    const controller = new AbortController();
    let doneCalls = 0;
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesQuestionnaireKey },
            (value: unknown) => {
              doneCalls++;
              resolve(value);
            },
          );
          controller.abort();
        }),
    );
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx, controller.signal);

    expect(doneCalls).toBe(1);
    expect(result.details).toEqual({ version: 1, status: "aborted", answers: [] });
    expect(result.terminate).toBe(true);
  });

  it("uses sequential built-in dialogs in RPC mode", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.mode = "rpc";
    ctx.ui.select = vi.fn(async () => "1. Tool result details");
    ctx.ui.input = vi.fn(async () => "1, CSV export");
    ctx.ui.confirm = vi.fn(async () => true);
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("Where should answers be stored?"),
      ["1. Tool result details", "2. Local file", "Type my own answer"],
      {},
    );
    expect(ctx.ui.input).toHaveBeenCalledWith(
      expect.stringContaining("Which interaction features should be included?"),
      "Comma-separated option numbers or custom text",
      {},
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Review answers",
      "Storage: Tool result details\nFeatures: Review tab; wrote: CSV export",
      {},
    );
    expect(result.details).toEqual({
      version: 1,
      status: "submitted",
      answers: [
        { questionId: "storage", selectedValues: ["details"] },
        { questionId: "features", selectedValues: ["review"], customText: "CSV export" },
      ],
    });
  });

  it("treats a rejected RPC review as dismissal", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.mode = "rpc";
    ctx.ui.select = vi.fn(async () => "1. Tool result details");
    ctx.ui.input = vi.fn(async () => "1");
    ctx.ui.confirm = vi.fn(async () => false);
    await askUserExtension(pi);

    const result = await executeTool(pi, { questions: QUESTIONS }, ctx);

    expect(result.details).toEqual({ version: 1, status: "dismissed", answers: [] });
    expect(result.terminate).toBe(true);
  });

  it.each(["print", "json"] as const)(
    "returns unavailable and deactivates itself in %s mode",
    async (mode) => {
      const pi = createMockPi();
      pi.getActiveTools = vi.fn(() => ["read", "ask_user"]);
      const ctx = createMockContext();
      ctx.mode = mode;
      ctx.hasUI = false;
      await askUserExtension(pi);

      const result = await executeTool(pi, { questions: QUESTIONS }, ctx);

      expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "ask_user requires interactive UI and has been disabled for this session.",
          },
        ],
        details: { version: 1, status: "unavailable", answers: [] },
        terminate: true,
      });
    },
  );

  it("returns a structured invalid result without opening UI", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    await askUserExtension(pi);

    const result = await executeTool(
      pi,
      { questions: [{ ...QUESTIONS[0] }, { ...QUESTIONS[0] }] },
      ctx,
    );

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(firstResultText(result)).toContain("Duplicate question id: storage");
    expect(result.details).toEqual({ version: 1, status: "invalid", answers: [] });
    expect(result.terminate).toBeUndefined();
  });

  it("renders compact call and result summaries", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    await askUserExtension(pi);
    const tool = getTool(pi);
    const call = tool.renderCall(
      { questions: QUESTIONS },
      ctx.ui.theme,
      createRenderContext({ questions: QUESTIONS }),
    );
    const details: AskUserDetails = {
      version: 1,
      status: "submitted",
      answers: [
        { questionId: "storage", selectedValues: ["details"] },
        { questionId: "features", selectedValues: ["review"], customText: "CSV export" },
      ],
    };
    const result = tool.renderResult(
      { content: [{ type: "text", text: "done" }], details },
      { expanded: false, isPartial: false },
      ctx.ui.theme,
      createRenderContext({ questions: QUESTIONS }),
    );

    expect(call.render(80).join("\n")).toContain("2 questions");
    expect(call.render(80).join("\n")).toContain("Storage, Features");
    expect(result.render(80).join("\n")).toContain("Storage: Tool result details");
    expect(result.render(80).join("\n")).toContain("Features: Review tab; wrote: CSV export");
  });

  it("renders a component for results with unrecognized details shapes", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    await askUserExtension(pi);
    const tool = getTool(pi);

    // pi writes details: {} when schema validation rejects the tool call.
    const validationFailure = tool.renderResult(
      {
        content: [{ type: "text", text: 'Validation failed for tool "ask_user"' }],
        details: {},
      } as unknown as AgentToolResult<AskUserDetails>,
      { expanded: false, isPartial: false },
      ctx.ui.theme,
      createRenderContext({ questions: QUESTIONS }),
    );

    expect(validationFailure).toBeDefined();
    expect(validationFailure.render(80).join("\n")).toContain("Validation failed");

    // Sessions from older extension versions can carry statuses this version no
    // longer emits.
    const unknownStatus = tool.renderResult(
      {
        content: [{ type: "text", text: "stale result text" }],
        details: { version: 1, status: "expired", answers: [] },
      } as unknown as AgentToolResult<AskUserDetails>,
      { expanded: false, isPartial: false },
      ctx.ui.theme,
      createRenderContext({ questions: QUESTIONS }),
    );

    expect(unknownStatus).toBeDefined();
    expect(unknownStatus.render(80).join("\n")).toContain("stale result text");
  });
});

describe("ask-user Herdr blocked events", () => {
  it.each(["submitted", "dismissed", "aborted"])(
    "balances blocked events when a TUI questionnaire is %s",
    async (status) => {
      const pi = createMockPi();
      const ctx = createMockContext();
      let finish: (value: unknown) => void = () => {};
      ctx.ui.custom = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await askUserExtension(pi);

      const pending = executeTool(pi, { questions: QUESTIONS }, ctx);
      expect(pi.events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
        active: true,
        label: "Ask User",
      });
      expect(pi.events.emit).toHaveBeenCalledTimes(1);
      finish(status === "submitted" ? { status, answers: [] } : { status });
      await pending;
      expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
      expect(pi.events.emit).toHaveBeenCalledTimes(2);
    },
  );

  it("clears the blocked event when the dialog rejects", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.ui.custom.mockRejectedValue(new Error("Dialog failed"));
    await askUserExtension(pi);
    await expect(executeTool(pi, { questions: QUESTIONS }, ctx)).rejects.toThrow("Dialog failed");
    expect(pi.events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: "Ask User",
    });
    expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
    expect(pi.events.emit).toHaveBeenCalledTimes(2);
  });

  it("balances each overlapping questionnaire independently", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    const finishers: Array<(value: unknown) => void> = [];
    ctx.ui.custom = vi.fn(
      () =>
        new Promise((resolve) => {
          finishers.push(resolve);
        }),
    );
    await askUserExtension(pi);
    const first = executeTool(pi, { questions: QUESTIONS }, ctx);
    const second = executeTool(pi, { questions: QUESTIONS }, ctx);
    expect(pi.events.emit).toHaveBeenCalledTimes(2);
    expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", {
      active: true,
      label: "Ask User",
    });
    finishers[0]({ status: "dismissed" });
    await first;
    expect(pi.events.emit).toHaveBeenCalledTimes(3);
    expect(pi.events.emit).toHaveBeenNthCalledWith(3, "herdr:blocked", { active: false });
    finishers[1]({ status: "aborted" });
    await second;
    expect(pi.events.emit).toHaveBeenCalledTimes(4);
    expect(pi.events.emit).toHaveBeenNthCalledWith(4, "herdr:blocked", { active: false });
  });

  it.each(["rpc", "json", "print", "invalid", "pre-aborted"])(
    "does not emit blocked events for %s requests",
    async (scenario) => {
      const pi = createMockPi();
      const ctx = createMockContext();
      const controller = new AbortController();
      if (scenario === "pre-aborted") controller.abort();
      if (scenario === "rpc" || scenario === "json" || scenario === "print") ctx.mode = scenario;
      ctx.ui.select.mockResolvedValue(undefined);
      await askUserExtension(pi);
      await executeTool(
        pi,
        { questions: scenario === "invalid" ? [] : QUESTIONS },
        ctx,
        controller.signal,
      );
      expect(pi.events.emit).not.toHaveBeenCalled();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    },
  );
});

describe("ask-user schema and state", () => {
  it("rejects terminal control characters and duplicate option values", () => {
    expect(
      validateQuestions([
        {
          ...QUESTIONS[0],
          options: [
            { value: "same", label: "Safe" },
            { value: "same", label: "\u001b[31mUnsafe" },
          ],
        },
      ]),
    ).toBe("Duplicate option value in storage: same");
    expect(validateQuestions([{ ...QUESTIONS[0], question: "Unsafe \u001b[2J" }])).toBe(
      "Question text contains terminal control characters: storage",
    );
  });

  it("requires one to four questions and two to six options when options are supplied", () => {
    expect(validateQuestions([])).toBe("Provide between 1 and 4 questions.");
    expect(
      validateQuestions([
        {
          id: "only",
          header: "Only",
          question: "Only one option?",
          options: [{ value: "one", label: "One" }],
        },
      ]),
    ).toBe("Question only must have between 2 and 6 options.");
  });

  it("retains selections when custom text is added to a multi-select question", () => {
    let state = createQuestionnaireState(QUESTIONS);
    state = reduceQuestionnaire(state, { type: "selectSingle", optionIndex: 0 }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "toggle", optionIndex: 0 }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "startCustom" }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "saveCustom", value: "CSV export" }, QUESTIONS);

    expect(toSubmittedAnswers(QUESTIONS, state)).toEqual([
      { questionId: "storage", selectedValues: ["details"] },
      { questionId: "features", selectedValues: ["review"], customText: "CSV export" },
    ]);
  });

  it("blocks review submission until every question is confirmed", () => {
    let state = createQuestionnaireState(QUESTIONS);
    state = reduceQuestionnaire(
      state,
      { type: "goTo", questionIndex: QUESTIONS.length },
      QUESTIONS,
    );

    expect(state.canSubmit).toBe(false);

    state = reduceQuestionnaire(state, { type: "goTo", questionIndex: 0 }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "selectSingle", optionIndex: 0 }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "toggle", optionIndex: 0 }, QUESTIONS);
    state = reduceQuestionnaire(state, { type: "confirmMulti" }, QUESTIONS);

    expect(state.currentIndex).toBe(QUESTIONS.length);
    expect(state.canSubmit).toBe(true);
  });

  it("renders every TUI line within narrow terminal widths", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    let component: Component | undefined;
    ctx.ui.custom = vi.fn((factory) => {
      component = factory(
        { requestRender: vi.fn() },
        ctx.ui.theme,
        { matches: matchesQuestionnaireKey },
        vi.fn(),
      );
      return Promise.resolve({ status: "dismissed" });
    });
    await askUserExtension(pi);

    await executeTool(pi, { questions: QUESTIONS }, ctx);

    if (!component) throw new Error("Questionnaire component was not created");
    for (const width of [0, 1, 2, 8, 16]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

function matchesQuestionnaireKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\u001b", "\u0003"],
    "tui.input.tab": ["\t"],
  };
  return keys[keybinding]?.includes(data) ?? false;
}

function firstResultText(result: AgentToolResult<AskUserDetails>): string | undefined {
  const content = result.content[0];
  return content?.type === "text" ? content.text : undefined;
}

interface AskUserTool {
  name: string;
  exposure?: string;
  executionMode?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<AskUserDetails>>;
  renderCall(
    args: unknown,
    theme: Theme,
    context: ToolRenderContext<Record<string, never>, unknown>,
  ): Component;
  renderResult(
    result: AgentToolResult<AskUserDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<Record<string, never>, unknown>,
  ): Component;
}

function getTool(pi: ReturnType<typeof createMockPi>): AskUserTool {
  const tool = pi.registerTool.mock.calls[0]?.[0];
  if (!tool) throw new Error("ask_user tool not registered");
  return tool as unknown as AskUserTool;
}

async function executeTool(
  pi: ReturnType<typeof createMockPi>,
  params: unknown,
  ctx: ReturnType<typeof createMockContext>,
  signal?: AbortSignal,
): Promise<AgentToolResult<AskUserDetails>> {
  return getTool(pi).execute("call-1", params, signal, undefined, ctx);
}

function createRenderContext(args: unknown): ToolRenderContext<Record<string, never>, unknown> {
  return {
    args,
    toolCallId: "call-1",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: "/home/test",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
  };
}
