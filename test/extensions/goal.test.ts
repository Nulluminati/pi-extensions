import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension, { STATUS_ICON } from "../../extensions/goal/goal.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

describe("goal-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/goal");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["goal.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(8);
    });
  });

  it("registers /goal command", async () => {
    const mockPi = createMockPi();
    await goalExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledTimes(1);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "goal",
      expect.objectContaining({
        description:
          "Run a goal to completion: /goal [--tokens 100k] <objective> | /goal budget <amount> | /goal pause|resume|clear|edit|status",
        handler: expect.any(Function),
      }),
    );
  });

  it("registers goal_complete tool with metadata", async () => {
    const mockPi = createMockPi();
    await goalExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(1);
    expect(mockPi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "goal_complete",
        label: "Goal Complete",
        promptSnippet: expect.stringContaining("Mark the active /goal as complete"),
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining("keep working until the goal is complete"),
        ]),
      }),
    );
  });

  it("registers event handlers", async () => {
    const mockPi = createMockPi();
    await goalExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
  });

  it("/goal with no active goal shows status message", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "No active goal. Use /goal <objective> to start one.",
      "info",
    );
  });

  it("/goal <objective> starts a new goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({
          objective: "implement snake game",
          status: "active",
          iteration: 0,
        }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Goal started: implement snake game", "info");
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Goal mode is active"),
      { deliverAs: "followUp" },
    );
  });

  it("/goal --tokens 100k <objective> starts with token budget", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 100k fix the failing test", mockCtx);
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({
          objective: "fix the failing test",
          status: "active",
          tokenBudget: 100_000,
        }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Goal started (budget: 100k): fix the failing test",
      "info",
    );
  });

  it("rejects goals exceeding 4000 characters", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("x".repeat(4001), mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("too long"), "warning");
  });

  it("/goal pause pauses active goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("pause", mockCtx);
    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "paused" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Goal paused. Use /goal resume to continue.",
      "info",
    );
  });

  it("/goal resume resumes a paused goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("pause", mockCtx);
    await handler("resume", mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("resumed the paused /goal"),
      { deliverAs: "followUp" },
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Goal resumed.", "info");
  });

  it("/goal clear cancels the goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("clear", mockCtx);
    expect(mockPi.appendEntry).toHaveBeenLastCalledWith("goal-state", { goal: null });
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
  });

  it("/goal edit updates objective without resetting counters", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("edit implement tetris game", mockCtx);
    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({
          objective: "implement tetris game",
          status: "active",
        }),
      }),
    );
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("objective was updated"),
      { deliverAs: "followUp" },
    );
  });

  it("goal_complete tool marks goal as complete", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal first
    const commandHandler = mockPi.registerCommand.mock.calls[0][1].handler;
    await commandHandler("implement snake game", mockCtx);

    // Call goal_complete
    const toolDef = mockPi.registerTool.mock.calls[0][0];
    const result = await toolDef.execute(
      "call-1",
      { summary: "Snake game implemented and tested" },
      undefined,
      undefined,
      mockCtx,
    );

    expect(result.content[0].text).toBe("Goal completed: Snake game implemented and tested");
    expect(result.terminate).toBe(true);
    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "complete" }),
      }),
    );
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining(STATUS_ICON));
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("complete"));
  });

  it("goal_complete tool errors when no active goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const toolDef = mockPi.registerTool.mock.calls[0][0];
    const result = await toolDef.execute("call-1", {}, undefined, undefined, mockCtx);
    expect(result.content[0].text).toBe("No active goal to complete.");
    expect(result.terminate).toBe(true);
  });

  it("before_agent_start injects goal system prompt when goal is active", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    // Invoke before_agent_start
    const beforeStartHandler = getEventHandler(mockPi, "before_agent_start");
    const result = await beforeStartHandler(
      {
        type: "before_agent_start",
        prompt: "test",
        systemPrompt: "base prompt",
        systemPromptOptions: {},
      },
      mockCtx,
    );

    expect((result as { systemPrompt: string }).systemPrompt).toContain("base prompt");
    expect((result as { systemPrompt: string }).systemPrompt).toContain("implement snake game");
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Goal-mode rules");
  });

  it("before_agent_start returns undefined when no active goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const beforeStartHandler = getEventHandler(mockPi, "before_agent_start");
    const result = await beforeStartHandler(
      {
        type: "before_agent_start",
        prompt: "test",
        systemPrompt: "base prompt",
        systemPromptOptions: {},
      },
      mockCtx,
    );
    expect(result).toBeUndefined();
  });

  it("agent_end queues continuation when goal is active and incomplete", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    // Invoke agent_end
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Continue the active /goal"),
      { deliverAs: "followUp" },
    );
  });

  it("agent_end does not queue continuation when goal_complete was called", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start and complete a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.sendUserMessage.mockClear();
    const toolDef = mockPi.registerTool.mock.calls[0][0];
    await toolDef.execute("call-1", {}, undefined, undefined, mockCtx);

    // Invoke agent_end
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("agent_end pauses goal when token budget is reached", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start goal with budget
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 10k implement snake game", mockCtx);

    // Simulate high token usage via turn_end
    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 10_500,
      contextWindow: 200_000,
      percent: 5.25,
    }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // Invoke agent_end
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "budget" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Token budget reached"),
      "warning",
    );
  });

  it("turn_end tracks token delta from baseline", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal at 2000 baseline tokens
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    mockCtx.getContextUsage = vi.fn(() => ({ tokens: 2000, contextWindow: 200_000, percent: 1 }));
    await handler("implement snake game", mockCtx);

    // Simulate turn end with 5000 total tokens (3000 delta)
    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ tokensUsed: 3000 }),
      }),
    );
  });

  it("message_end pauses goal on stopReason error", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    // Simulate error message end
    const messageEndHandler = getEventHandler(mockPi, "message_end");
    await messageEndHandler(
      { type: "message_end", message: { role: "assistant", stopReason: "error" } },
      mockCtx,
    );

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "paused" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Goal paused due to interruption or error"),
      "warning",
    );
  });

  it("reconstructs state from session on session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    // Pre-populate session with a goal state entry (wrapped in { goal })
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            objective: "existing goal",
            status: "active",
            startTime: Date.now(),
            elapsedMs: 0,
            iteration: 3,
            tokensUsed: 1000,
            baselineTokens: 0,
            lastTurnTimestamp: Date.now(),
          },
        },
      },
    ]);

    await goalExtension(mockPi);
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "startup" }, mockCtx);

    // Check status reflects reconstructed state
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("active"));
  });

  it("input event cancels pending continuation", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.sendUserMessage.mockClear();

    // Queue continuation via agent_end
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

    // User sends manual input
    const inputHandler = getEventHandler(mockPi, "input");
    await inputHandler({ type: "input", text: "manual message", source: "interactive" }, mockCtx);

    // Next agent_end should not send another continuation because user has pending message
    mockCtx.hasPendingMessages = vi.fn(() => true);
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("session_shutdown persists state", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    // Shutdown
    const shutdownHandler = getEventHandler(mockPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "quit" }, mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ objective: "implement snake game" }),
      }),
    );
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
  });

  it("handles quoted objectives in /goal command", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler('"fix the auth bug"', mockCtx);
    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ objective: "fix the auth bug" }),
      }),
    );
  });

  it("shows usage error for invalid command", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("pause extra-arg", mockCtx);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /goal pause"),
      "warning",
    );
  });

  it("starting a new goal after completion queues first continuation", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Goal A: start and complete
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.sendUserMessage.mockClear();
    const toolDef = mockPi.registerTool.mock.calls[0][0];
    await toolDef.execute("call-1", {}, undefined, undefined, mockCtx);

    // Goal B: start new goal
    await handler("implement tetris game", mockCtx);
    mockPi.sendUserMessage.mockClear();

    // First agent_end of Goal B should still queue continuation
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("Continue the active /goal"),
      { deliverAs: "followUp" },
    );
  });

  it("start clears completion status from previous goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    // Start and complete a goal
    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    const toolDef = mockPi.registerTool.mock.calls[0][0];
    await toolDef.execute("call-1", {}, undefined, undefined, mockCtx);

    // Clear setStatus mock to isolate the new goal start
    mockCtx.ui.setStatus.mockClear();

    // Start a new goal — should clear status first
    await handler("implement tetris game", mockCtx);

    // First call after clear should be undefined (from clearCompletionStatus)
    expect(mockCtx.ui.setStatus).toHaveBeenNthCalledWith(1, "goal", undefined);
  });

  it("resume clears completion status", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("pause", mockCtx);

    mockCtx.ui.setStatus.mockClear();
    await handler("resume", mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenNthCalledWith(1, "goal", undefined);
  });

  it("calling goal_complete twice on the same goal returns error on second call", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    const toolDef = mockPi.registerTool.mock.calls[0][0];

    // First call succeeds
    const result1 = await toolDef.execute("call-1", {}, undefined, undefined, mockCtx);
    expect(result1.content[0].text).toBe("Goal completed.");
    expect(result1.terminate).toBe(true);

    // Second call errors
    const result2 = await toolDef.execute("call-2", {}, undefined, undefined, mockCtx);
    expect(result2.content[0].text).toBe("No active goal to complete.");
    expect(result2.terminate).toBe(true);
  });

  it("reconstructState skips completed goals", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            objective: "old goal",
            status: "complete",
            startTime: Date.now(),
            elapsedMs: 1000,
            iteration: 2,
            tokensUsed: 500,
            baselineTokens: 0,
          },
        },
      },
    ]);

    await goalExtension(mockPi);
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
  });

  it("message_end pauses goal on stopReason aborted", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    const messageEndHandler = getEventHandler(mockPi, "message_end");
    await messageEndHandler(
      { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
      mockCtx,
    );

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "paused" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Goal paused due to interruption or error"),
      "warning",
    );
  });

  it("session_tree reconstructs state like session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            objective: "existing goal",
            status: "active",
            startTime: Date.now(),
            elapsedMs: 0,
            iteration: 3,
            tokensUsed: 1000,
            baselineTokens: 0,
            lastTurnTimestamp: Date.now(),
          },
        },
      },
    ]);

    await goalExtension(mockPi);
    const sessionTreeHandler = getEventHandler(mockPi, "session_tree");
    await sessionTreeHandler({ type: "session_tree", reason: "navigate" }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("active"));
  });

  it("edit on paused goal does not send follow-up prompt", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("pause", mockCtx);
    mockPi.sendUserMessage.mockClear();

    await handler("edit implement tetris game", mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({
          objective: "implement tetris game",
          status: "paused",
        }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Goal updated: implement tetris game", "info");
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("resume fails when goal is in budget status", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 10k implement snake game", mockCtx);

    // Hit budget via turn_end
    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 10_500,
      contextWindow: 200_000,
      percent: 5.25,
    }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // agent_end should set budget status
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "budget" }),
      }),
    );

    // Try to resume
    mockCtx.ui.notify.mockClear();
    await handler("resume", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Cannot resume: token budget reached"),
      "warning",
    );
    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "budget" }),
      }),
    );
  });

  it("/goal budget sets new token budget on active goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.appendEntry.mockClear();

    await handler("budget 200k", mockCtx);

    expect(mockPi.appendEntry).toHaveBeenCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ tokenBudget: 200_000, status: "active" }),
      }),
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Goal budget set to 200k"),
      "info",
    );
  });

  it("/goal budget resumes goal from budget status", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 10k implement snake game", mockCtx);

    // Hit budget via turn_end
    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 10_500,
      contextWindow: 200_000,
      percent: 5.25,
    }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // agent_end should set budget status
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    mockPi.sendUserMessage.mockClear();

    // Increase budget to resume
    await handler("budget 50k", mockCtx);

    expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
      "goal-state",
      expect.objectContaining({
        goal: expect.objectContaining({ status: "active", tokenBudget: 50_000 }),
      }),
    );
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("resumed the paused /goal"),
      { deliverAs: "followUp" },
    );
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Goal budget set to 50k. Goal resumed."),
      "info",
    );
  });

  it("/goal budget with no goal shows info message", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("budget 100k", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "No active goal. Use /goal <objective> to start one.",
      "info",
    );
  });

  it("/goal budget with invalid amount shows error", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("budget abc", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid token budget"),
      "warning",
    );
  });

  it("goal_complete tool is disabled on session_start with no active goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => []);
    await goalExtension(mockPi);
    mockPi.setActiveTools.mockClear();

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("starting a goal enables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);
    mockPi.setActiveTools.mockClear();

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["goal_complete"]));
  });

  it("pausing a goal disables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.setActiveTools.mockClear();

    await handler("pause", mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("resuming a goal enables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    await handler("pause", mockCtx);
    mockPi.setActiveTools.mockClear();

    await handler("resume", mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["goal_complete"]));
  });

  it("completing a goal disables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.setActiveTools.mockClear();

    const toolDef = mockPi.registerTool.mock.calls[0][0];
    await toolDef.execute("call-1", { summary: "done" }, undefined, undefined, mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("clearing a goal disables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.setActiveTools.mockClear();

    await handler("clear", mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("budget reached disables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 10k implement snake game", mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 10_500,
      contextWindow: 200_000,
      percent: 5.25,
    }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    mockPi.setActiveTools.mockClear();
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("budget resume re-enables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("--tokens 10k implement snake game", mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 10_500,
      contextWindow: 200_000,
      percent: 5.25,
    }));
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    mockPi.setActiveTools.mockClear();
    await handler("budget 50k", mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["goal_complete"]));
  });

  it("message_end error disables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);
    mockPi.setActiveTools.mockClear();

    const messageEndHandler = getEventHandler(mockPi, "message_end");
    await messageEndHandler(
      { type: "message_end", message: { role: "assistant", stopReason: "error" } },
      mockCtx,
    );

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(
      expect.not.arrayContaining(["goal_complete"]),
    );
  });

  it("session_start with active goal enables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            objective: "existing goal",
            status: "active",
            startTime: Date.now(),
            elapsedMs: 0,
            iteration: 3,
            tokensUsed: 1000,
            baselineTokens: 0,
            lastTurnTimestamp: Date.now(),
          },
        },
      },
    ]);

    await goalExtension(mockPi);
    // The initial disable fires first, then session_start re-enables
    mockPi.setActiveTools.mockClear();
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "startup" }, mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["goal_complete"]));
  });

  it("session_tree with active goal enables goal_complete tool", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: {
            id: "goal-1",
            objective: "existing goal",
            status: "active",
            startTime: Date.now(),
            elapsedMs: 0,
            iteration: 3,
            tokensUsed: 1000,
            baselineTokens: 0,
            lastTurnTimestamp: Date.now(),
          },
        },
      },
    ]);

    await goalExtension(mockPi);
    mockPi.setActiveTools.mockClear();
    const sessionTreeHandler = getEventHandler(mockPi, "session_tree");
    await sessionTreeHandler({ type: "session_tree", reason: "navigate" }, mockCtx);

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["goal_complete"]));
  });

  it("completionStatusTimer is nulled after firing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await goalExtension(mockPi);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("implement snake game", mockCtx);

    const toolDef = mockPi.registerTool.mock.calls[0][0];
    await toolDef.execute("call-1", { summary: "done" }, undefined, undefined, mockCtx);

    // Status should be set to "complete"
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining(STATUS_ICON));
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("complete"));

    // After the timer fires, status should be cleared
    mockCtx.ui.setStatus.mockClear();
    vi.advanceTimersByTime(9000);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
    vi.useRealTimers();
  });

  // --- renderResult ---

  describe("renderResult", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    function getGoalCompleteTool(mockPi: any): any {
      return mockPi.registerTool.mock.calls[0][0];
    }

    it("shows compact success line without a summary", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const tool = getGoalCompleteTool(mockPi);
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Goal completed." }],
        details: { status: "complete" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, { args: {} });
      const lines = component.render(80);
      expect(lines[0]).toContain("Goal");
      expect(lines[0]).toContain("complete");
    });

    it("includes the summary when provided", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const tool = getGoalCompleteTool(mockPi);
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Goal completed: shipped the feature" }],
        details: { status: "complete", summary: "shipped the feature" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, { args: {} });
      const lines = component.render(80);
      expect(lines[0]).toContain("shipped the feature");
    });

    it("shows compact error line when details.error is set", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const tool = getGoalCompleteTool(mockPi);
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "No active goal to complete." }],
        details: { error: "no_active_goal" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, { args: {} });
      const lines = component.render(80);
      expect(lines[0]).toContain("Goal");
      expect(lines[0]).toContain("No active goal to complete.");
    });

    it("shows loading state when isPartial", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const tool = getGoalCompleteTool(mockPi);
      const theme = { fg: (_c: string, text: string) => text };
      const result = { content: [{ type: "text", text: "" }], details: {} };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: true }, theme, { args: {} });
      const lines = component.render(80);
      expect(lines[0]).toContain("completing");
    });

    it("shows content when expanded", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const tool = getGoalCompleteTool(mockPi);
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Goal completed: full summary text" }],
        details: { status: "complete", summary: "full summary text" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: true, isPartial: false }, theme, { args: {} });
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("full summary text"))).toBe(true);
    });
  });
});
