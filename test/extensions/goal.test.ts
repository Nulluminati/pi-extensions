import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../extensions/goal/goal.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler, makeConfirmCustom } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

describe("goal-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PI_SMALL_MODEL", "test-provider/test-model");
    vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(7);
    });
  });

  describe("registration", () => {
    it("registers the /goal commands", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      const commands = mockPi.registerCommand.mock.calls.map((call: unknown[]) => call[0]);
      expect(commands).toEqual([
        "goal",
        "goal:status",
        "goal:new",
        "goal:edit",
        "goal:pause",
        "goal:resume",
        "goal:reset",
      ]);
      expect(mockPi.registerCommand).toHaveBeenCalledWith(
        "goal:new",
        expect.objectContaining({
          description: expect.stringContaining("--iterations"),
          handler: expect.any(Function),
        }),
      );
    });

    it("registers no LLM-facing tools (completion is decided by the evaluator)", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      expect(mockPi.registerTool).not.toHaveBeenCalled();
    });

    it("registers event handlers", async () => {
      const mockPi = createMockPi();
      await goalExtension(mockPi);
      expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("input", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("context", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
    });
  });

  describe("start", () => {
    it("/goal <objective> starts a new goal", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("implement snake game", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({
            objective: "implement snake game",
            status: "active",
            iteration: 0,
            maxIterations: 25,
          }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Goal started: implement snake game", "info");
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Goal mode is active"),
        { deliverAs: "followUp" },
      );
    });

    it("/goal behaves like /goal:new", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal")("implement snake game", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ objective: "implement snake game", status: "active" }),
        }),
      );
    });

    it("/goal --iterations 40 <objective> sets the iteration cap", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("--iterations 40 fix the failing test", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({
            objective: "fix the failing test",
            status: "active",
            maxIterations: 40,
          }),
        }),
      );
    });

    it("/goal --iterations 0 means unlimited", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("--iterations 0 fix the failing test", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ maxIterations: 0 }),
        }),
      );
    });

    it("/goal --iterations with an invalid amount shows an error", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("--iterations abc fix things", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Invalid iteration cap"),
        "warning",
      );
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("/goal --iterations without an amount shows usage", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("--iterations", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage: /goal:new --iterations"),
        "warning",
      );
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("rejects goals exceeding 4000 characters", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("x".repeat(4001), mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("too long"),
        "warning",
      );
    });

    it("handles quoted objectives", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal('"fix the auth bug"', mockCtx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ objective: "fix the auth bug" }),
        }),
      );
    });

    it("/goal with no args prompts for an objective and starts it", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.ui.custom = makePromptCustom(mockCtx, "implement snake game");
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("", mockCtx);
      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ objective: "implement snake game", status: "active" }),
        }),
      );
    });

    it("/goal with no args does nothing when the prompt is cancelled", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.ui.custom = makePromptCustom(mockCtx, null);
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("", mockCtx);
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("/goal:new does nothing in non-UI mode without args", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await goalExtension(mockPi);
      const newGoal = getCommandHandler(mockPi, "goal:new");
      await newGoal("", mockCtx);
      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("goal commands do nothing in non-UI mode", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await goalExtension(mockPi);
      for (const command of [
        "goal",
        "goal:new",
        "goal:status",
        "goal:edit",
        "goal:pause",
        "goal:resume",
        "goal:reset",
      ]) {
        await getCommandHandler(mockPi, command)("some args", mockCtx);
      }
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
      expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  describe("per-turn goal context injection", () => {
    it("before_agent_start returns a goal-context message while a goal is active", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);

      const beforeStartHandler = getEventHandler(mockPi, "before_agent_start");
      const result = (await beforeStartHandler(
        { type: "before_agent_start", prompt: "test", systemPrompt: "base prompt" },
        mockCtx,
      )) as { systemPrompt?: string; message?: { customType?: string; content: unknown[] } };

      // The system prompt must never be touched — that would break prefix caching.
      expect(result.systemPrompt).toBeUndefined();
      expect(result.message?.customType).toBe("goal-context");
      const text = JSON.stringify(result.message?.content);
      expect(text).toContain("implement snake game");
      expect(text).toContain("Goal-mode rules");
    });

    it("before_agent_start returns undefined when no goal is active", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      const beforeStartHandler = getEventHandler(mockPi, "before_agent_start");
      const result = await beforeStartHandler(
        { type: "before_agent_start", prompt: "test", systemPrompt: "base prompt" },
        mockCtx,
      );
      expect(result).toBeUndefined();
    });

    it("context event strips stale goal-context copies from history", async () => {
      const mockPi = createMockPi();
      const _mockCtx = createMockCommandContext();
      await goalExtension(mockPi);

      const contextHandler = getEventHandler(mockPi, "context");
      const result = (await contextHandler({
        type: "context",
        messages: [
          { role: "user", content: "hello" },
          { customType: "goal-context", content: [{ type: "text", text: "old copy" }] },
          { role: "assistant", content: "hi" },
        ],
      })) as { messages?: unknown[] };

      expect(result.messages).toHaveLength(2);
      expect(JSON.stringify(result.messages)).not.toContain("goal-context");
    });

    it("context event returns undefined when there are no goal-context copies", async () => {
      const mockPi = createMockPi();
      const _mockCtx = createMockCommandContext();
      await goalExtension(mockPi);

      const contextHandler = getEventHandler(mockPi, "context");
      const result = await contextHandler({
        type: "context",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result).toBeUndefined();
    });
  });

  describe("evaluator lifecycle", () => {
    it("agent_end with a met verdict completes the goal", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("met", "tests pass and the game runs");

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "complete" }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Goal complete"),
        "info",
      );
      expect(mockPi.events.emit).toHaveBeenCalledWith("goal:state-change", {
        status: "complete",
        iteration: 0,
        maxIterations: 25,
      });
      expect(mockPi.sendUserMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("Continue the active /goal"),
        expect.anything(),
      );
    });

    it("agent_end with a not_met verdict queues a continuation carrying the evaluator reason", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("not_met", "the game loop is not implemented yet");

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("the game loop is not implemented yet"),
        { deliverAs: "followUp" },
      );
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active", iteration: 1 }),
        }),
      );
    });

    it("agent_end with an impossible verdict pauses the goal and reports why", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      mockVerdict("impossible", "the target module does not exist in this repo");

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("impossible"),
        "warning",
      );
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("evaluator failure leaves the goal active and returns control without continuing", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      vi.mocked(completeSimple).mockRejectedValueOnce(new Error("small model not configured"));

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Goal evaluation failed"),
        "warning",
      );
      expect(mockPi.appendEntry).not.toHaveBeenCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("an unparseable evaluator response is treated as an evaluation failure", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      vi.mocked(completeSimple).mockResolvedValueOnce({
        content: [{ type: "text", text: "The goal looks mostly done to me." }],
      });

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Goal evaluation failed"),
        "warning",
      );
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("agent_end does nothing when the goal is paused", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:pause")("", mockCtx);
      mockPi.sendUserMessage.mockClear();

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(completeSimple).not.toHaveBeenCalled();
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("agent_end skips evaluation when user messages are pending", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockCtx.hasPendingMessages = vi.fn(() => true);

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(completeSimple).not.toHaveBeenCalled();
    });

    it("the evaluator prompt contains the objective and transcript evidence", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "implement snake game" }] },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done. All tests pass." }],
          },
        },
      ]);
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("met", "evidence cited");

      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(completeSimple).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(completeSimple).mock.calls[0][1] as {
        messages: Array<{ content: Array<{ text: string }> }>;
      };
      const prompt = payload.messages[0].content[0].text;
      expect(prompt).toContain("implement snake game");
      expect(prompt).toContain("All tests pass");
    });
  });

  describe("non-UI mode", () => {
    /** A ctx for rpc/json/print modes: notify must never be called. */
    function makeNonUiContext() {
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      mockCtx.ui.notify = vi.fn(() => {
        throw new Error("ui.notify is unavailable in non-UI mode");
      });
      return mockCtx;
    }

    it("agent_end with an impossible verdict pauses the goal without notifying", async () => {
      const mockPi = createMockPi();
      const startCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", startCtx);

      // The turn ends in a non-UI mode (e.g. --mode json).
      const mockCtx = makeNonUiContext();
      mockVerdict("impossible", "the target module does not exist in this repo");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    });

    it("agent_end with a met verdict completes the goal without notifying", async () => {
      const mockPi = createMockPi();
      const startCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", startCtx);

      const mockCtx = makeNonUiContext();
      mockVerdict("met", "tests pass and the game runs");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "complete" }),
        }),
      );
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    });

    it("message_end with an error stop reason pauses the goal without notifying", async () => {
      const mockPi = createMockPi();
      const startCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", startCtx);

      const mockCtx = makeNonUiContext();
      await getEventHandler(mockPi, "message_end")(
        { type: "message_end", message: { role: "assistant", stopReason: "error" } },
        mockCtx,
      );

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
      expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    });
  });

  describe("runaway guards", () => {
    it("pauses when the iteration cap is reached", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("--iterations 1 implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      const inputHandler = getEventHandler(mockPi, "input");

      // Turn 1: not_met queues continuation #1 (iteration 1 == cap).
      mockVerdict("not_met", "not done yet");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Turn 2 ends: not_met but iteration cap hit → pause.
      await inputHandler({ type: "input", text: "continue", source: "interactive" }, mockCtx);
      mockVerdict("not_met", "still not done");
      await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused", iteration: 1 }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Iteration cap reached"),
        "warning",
      );
    });

    it("pauses after three consecutive turns without tool use", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      const inputHandler = getEventHandler(mockPi, "input");

      for (let turn = 0; turn < 3; turn++) {
        if (turn > 0) {
          await inputHandler({ type: "input", text: "continue", source: "interactive" }, mockCtx);
        }
        mockVerdict("not_met", "churning without progress");
        await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused", consecutiveNoToolTurns: 3 }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No progress detected"),
        "warning",
      );
    });

    it("tool use resets the no-progress counter", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      const inputHandler = getEventHandler(mockPi, "input");

      // Two no-tool turns...
      for (const _turn of [0, 1]) {
        mockVerdict("not_met", "not done yet");
        await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
        await inputHandler({ type: "input", text: "continue", source: "interactive" }, mockCtx);
      }
      // ...then a turn that used tools...
      mockVerdict("not_met", "making progress now");
      await agentEndHandler(
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", name: "read", arguments: { path: "src/x.ts" } }],
            },
          ],
        },
        mockCtx,
      );
      // ...then two more no-tool turns: counter must be at 2, not 5.
      for (const _turn of [0, 1]) {
        await inputHandler({ type: "input", text: "continue", source: "interactive" }, mockCtx);
        mockVerdict("not_met", "not done yet");
        await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active", consecutiveNoToolTurns: 2 }),
        }),
      );
    });

    it("--iterations 0 never caps continuations", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("--iterations 0 implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      const inputHandler = getEventHandler(mockPi, "input");

      for (let turn = 0; turn < 4; turn++) {
        if (turn > 0) {
          await inputHandler({ type: "input", text: "continue", source: "interactive" }, mockCtx);
        }
        mockVerdict("not_met", "not done yet");
        await agentEndHandler(
          {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
              },
            ],
          },
          mockCtx,
        );
      }

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active" }),
        }),
      );
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(4);
    });
  });

  describe("lifecycle commands", () => {
    it("/goal:status with no active goal shows status message", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:status")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "No active goal. Use /goal:new <objective> to start one.",
        "info",
      );
    });

    it("/goal:status shows the last evaluator reason once one exists", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("not_met", "the game loop is not implemented yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      mockCtx.ui.notify.mockClear();
      await getCommandHandler(mockPi, "goal:status")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("the game loop is not implemented yet"),
        "info",
      );
    });

    it("/goal pause pauses active goal", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:pause")("", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "Goal paused. Use /goal:resume to continue.",
        "info",
      );
    });

    it("/goal resume resumes a paused goal and resets the no-progress counter", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:pause")("", mockCtx);
      await getCommandHandler(mockPi, "goal:resume")("", mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("resumed the paused /goal"),
        { deliverAs: "followUp" },
      );
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active", consecutiveNoToolTurns: 0 }),
        }),
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Goal resumed.", "info");
    });

    it("/goal reset cancels the goal after confirmation", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.ui.custom = makeConfirmCustom(mockCtx, true);
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:reset")("", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith("goal-state", { goal: null });
      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
      expect(mockPi.events.emit).toHaveBeenCalledWith("goal:state-change", { status: null });
    });

    it("/goal reset declined keeps the goal", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.ui.custom = makeConfirmCustom(mockCtx, false);
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.appendEntry.mockClear();
      await getCommandHandler(mockPi, "goal:reset")("", mockCtx);
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("/goal edit <objective> updates objective and sends a follow-up while active", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:edit")("implement tetris game", mockCtx);
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

    it("edit on paused goal does not send follow-up prompt", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      await getCommandHandler(mockPi, "goal:pause")("", mockCtx);
      mockPi.sendUserMessage.mockClear();

      await getCommandHandler(mockPi, "goal:edit")("implement tetris game", mockCtx);

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

    it("starting a new goal after completion starts fresh", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);

      // Goal A: start, then evaluator says met.
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("met", "done");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      // Goal B: start fresh.
      await getCommandHandler(mockPi, "goal:new")("implement tetris game", mockCtx);
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ objective: "implement tetris game", status: "active" }),
        }),
      );

      // First agent_end of Goal B evaluates and queues a continuation.
      mockVerdict("not_met", "not started yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Continue the active /goal"),
        { deliverAs: "followUp" },
      );
    });
  });

  describe("state tracking", () => {
    it("turn_end tracks token delta from baseline", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);

      // Start a goal at 2000 baseline tokens.
      mockCtx.getContextUsage = vi.fn(() => ({ tokens: 2000, contextWindow: 200_000, percent: 1 }));
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);

      // Simulate turn end with 5000 total tokens (3000 delta).
      mockCtx.getContextUsage = vi.fn(() => ({
        tokens: 5000,
        contextWindow: 200_000,
        percent: 2.5,
      }));
      await getEventHandler(mockPi, "turn_end")(
        { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] },
        mockCtx,
      );

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ tokensUsed: 3000 }),
        }),
      );
    });

    it("reconstructs state from session on session_start", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "custom", customType: "goal-state", data: { goal: makeGoalState() } },
      ]);

      await goalExtension(mockPi);
      await getEventHandler(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("active"));
      expect(mockPi.events.emit).toHaveBeenCalledWith("goal:state-change", {
        status: "active",
        iteration: 3,
      });
    });

    it("publishes the iteration count and cap on the state event", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockVerdict("not_met", "not done yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.events.emit).toHaveBeenLastCalledWith("goal:state-change", {
        status: "active",
        iteration: 1,
        maxIterations: 25,
      });
    });

    it("reconstructs legacy budget-status goals as paused", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        {
          type: "custom",
          customType: "goal-state",
          data: { goal: makeGoalState({ status: "budget" as "paused", tokenBudget: 10_000 }) },
        },
      ]);

      await goalExtension(mockPi);
      await getEventHandler(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("paused"));
      expect(mockPi.events.emit).toHaveBeenCalledWith("goal:state-change", {
        status: "paused",
        iteration: 3,
      });
    });

    it("reconstructState skips completed goals", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        {
          type: "custom",
          customType: "goal-state",
          data: { goal: makeGoalState({ status: "complete" }) },
        },
      ]);

      await goalExtension(mockPi);
      await getEventHandler(mockPi, "session_start")(
        { type: "session_start", reason: "startup" },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
    });

    it("session_tree reconstructs state like session_start", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "custom", customType: "goal-state", data: { goal: makeGoalState() } },
      ]);

      await goalExtension(mockPi);
      await getEventHandler(mockPi, "session_tree")(
        { type: "session_tree", reason: "navigate" },
        mockCtx,
      );

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", expect.stringContaining("active"));
    });

    it("session_shutdown persists state", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);

      await getEventHandler(mockPi, "session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        mockCtx,
      );

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ objective: "implement snake game" }),
        }),
      );
      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
    });

    it("a delivered extension message resets the guard so the loop continues unattended", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();
      const agentEndHandler = getEventHandler(mockPi, "agent_end");
      const inputHandler = getEventHandler(mockPi, "input");
      const toolMessages = [
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
        },
      ];

      // Turn 1 ends: evaluator queues continuation #1.
      mockVerdict("not_met", "not done yet");
      await agentEndHandler({ type: "agent_end", messages: toolMessages }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

      // The queued continuation is delivered (input fires with source
      // "extension") — no user input involved.
      await inputHandler(
        {
          type: "input",
          text: "Continue the active /goal",
          source: "extension",
          streamingBehavior: "followUp",
        },
        mockCtx,
      );

      // Turn 2 ends: the loop must evaluate and queue again, unattended.
      mockVerdict("not_met", "still not done");
      await agentEndHandler({ type: "agent_end", messages: toolMessages }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);
      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "active", iteration: 2 }),
        }),
      );
    });

    it("agent_end does not queue twice when no message was delivered in between", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();

      mockVerdict("not_met", "not done yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("input event cancels pending continuation and pending messages block re-queueing", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
      mockPi.sendUserMessage.mockClear();

      // Queue a continuation via agent_end.
      mockVerdict("not_met", "not done yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

      // User sends manual input; next turn has pending messages.
      await getEventHandler(mockPi, "input")(
        { type: "input", text: "manual message", source: "interactive" },
        mockCtx,
      );
      mockCtx.hasPendingMessages = vi.fn(() => true);
      mockVerdict("not_met", "not done yet");
      await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("message_end pauses goal on stopReason error", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);

      await getEventHandler(mockPi, "message_end")(
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

    it("message_end pauses goal on stopReason aborted", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await goalExtension(mockPi);
      await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);

      await getEventHandler(mockPi, "message_end")(
        { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
        mockCtx,
      );

      expect(mockPi.appendEntry).toHaveBeenLastCalledWith(
        "goal-state",
        expect.objectContaining({
          goal: expect.objectContaining({ status: "paused" }),
        }),
      );
    });

    it("a met verdict shows a transient completion status that clears itself", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const mockPi = createMockPi();
        const mockCtx = createMockCommandContext();
        await goalExtension(mockPi);
        await getCommandHandler(mockPi, "goal:new")("implement snake game", mockCtx);
        mockVerdict("met", "done");
        await getEventHandler(mockPi, "agent_end")({ type: "agent_end", messages: [] }, mockCtx);

        expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
          "goal",
          expect.stringContaining("complete"),
        );

        mockCtx.ui.setStatus.mockClear();
        vi.advanceTimersByTime(9000);
        expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("goal", undefined);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// --- Helpers ---

// Queue an evaluator verdict for the next completeSimple call.
function mockVerdict(status: "met" | "not_met" | "impossible", reason: string) {
  vi.mocked(completeSimple).mockResolvedValueOnce({
    content: [{ type: "text", text: JSON.stringify({ status, reason }) }],
  });
}

// A valid active goal as persisted in goal-state entries.
function makeGoalState(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    objective: "existing goal",
    status: "active" as const,
    startTime: Date.now(),
    elapsedMs: 0,
    iteration: 3,
    tokensUsed: 1000,
    baselineTokens: 0,
    lastTurnTimestamp: Date.now(),
    ...overrides,
  };
}

// Drives the framed promptText modal: types `typed` then Enter, or Esc when null.
function makePromptCustom(
  mockCtx: ReturnType<typeof createMockCommandContext>,
  typed: string | null,
) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  return vi.fn((factory: any) => {
    return new Promise((resolve) => {
      const component = factory(
        { requestRender: vi.fn() },
        mockCtx.ui.theme,
        {
          matches: (data: string, keybinding: string) =>
            ({
              "tui.select.confirm": ["\r", "\n"],
              "tui.select.cancel": ["\u001b", "\u0003"],
            })[keybinding]?.includes(data) ?? false,
        },
        resolve,
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      ) as any;
      if (typed === null) {
        component.handleInput("\u001b");
      } else {
        for (const character of typed) component.handleInput(character);
        component.handleInput("\r");
      }
    });
  });
}
