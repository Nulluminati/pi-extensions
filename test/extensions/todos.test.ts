import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import todosExtension from "../../extensions/todos/todos.ts";
import { getTodoItems } from "../../lib/todos.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

describe("todos-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/todos");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["todos.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(1);
    });
  });

  it("registers the todo tool, commands, and event subscription", async () => {
    const mockPi = createMockPi();
    await todosExtension(mockPi);

    expect(mockPi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "todo",
        parameters: expect.objectContaining({ required: ["action"] }),
      }),
    );
    const commands = mockPi.registerCommand.mock.calls.map((call: unknown[]) => call[0]);
    expect(commands).toEqual(["todos", "todos:clear"]);
    expect(mockPi.events.on).toHaveBeenCalledWith("todos:changed", expect.any(Function));

    const events = mockPi.on.mock.calls.map((call: unknown[]) => call[0]);
    expect(events).toEqual(
      expect.arrayContaining(["session_start", "session_tree", "session_shutdown"]),
    );
  });

  describe("todo tool", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    function getTool(mockPi: ReturnType<typeof createMockPi>): any {
      const calls = mockPi.registerTool.mock.calls;
      for (const call of calls) {
        if (call[0].name === "todo") return call[0];
      }
      throw new Error("todo tool not found");
    }

    it("add creates items, persists, and publishes", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      const result = await getTool(mockPi).execute(
        "call-1",
        { action: "add", items: ["first", "second"] },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.content[0].text).toContain("Added 2 item(s)");
      expect(result.details.items).toHaveLength(2);
      expect(result.terminate).toBeFalsy();
      expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["first", "second"]);
      expect(mockPi.appendEntry).toHaveBeenCalledWith("todos-state", expect.any(Object));
      expect(mockPi.events.emit).toHaveBeenCalledWith("todos:changed", expect.any(Object));
    });

    it("add with no usable items errors with terminate", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      const result = await getTool(mockPi).execute(
        "call-1",
        { action: "add", items: ["  "] },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details).toEqual({ error: "no_items" });
      expect(result.terminate).toBe(true);
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("check marks items and returns the updated list", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["a", "b", "c"] },
        undefined,
        undefined,
        mockCtx,
      );

      const result = await tool.execute(
        "call-2",
        { action: "check", ids: [1, 3] },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.content[0].text).toContain("Marked 2 item(s)");
      expect(
        result.details.items.map((item: { text: string; completed: boolean }) => item.completed),
      ).toEqual([true, false, true]);
    });

    it("check with no ids errors with terminate", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      const result = await getTool(mockPi).execute(
        "call-1",
        { action: "check" },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details).toEqual({ error: "no_ids" });
      expect(result.terminate).toBe(true);
    });

    it("uncheck restores items", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute("call-1", { action: "add", items: ["a"] }, undefined, undefined, mockCtx);
      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);

      const result = await tool.execute(
        "call-3",
        { action: "uncheck", ids: [1] },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details.items[0].completed).toBe(false);
    });

    it("check with non-matching ids reports no match", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute("call-1", { action: "add", items: ["a"] }, undefined, undefined, mockCtx);

      const result = await tool.execute(
        "call-2",
        { action: "check", ids: [9] },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.content[0].text).toContain("No items matched");
      expect(mockPi.events.emit).toHaveBeenCalledTimes(1); // only the add published
    });

    it("clear empties the list", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute("call-1", { action: "add", items: ["a"] }, undefined, undefined, mockCtx);

      const result = await tool.execute(
        "call-2",
        { action: "clear" },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details.items).toEqual([]);
      expect(getTodoItems(mockPi)).toEqual([]);
    });

    it("list returns the current items", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute("call-1", { action: "add", items: ["a"] }, undefined, undefined, mockCtx);

      const result = await tool.execute(
        "call-2",
        { action: "list" },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.content[0].text).toContain("1. ☐ a");
      expect(result.details.items).toHaveLength(1);
    });

    it("unknown action errors with terminate", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      const result = await getTool(mockPi).execute(
        "call-1",
        { action: "explode" },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details).toEqual({ error: "unknown_action" });
      expect(result.terminate).toBe(true);
    });
  });

  describe("widget", () => {
    it("renders the list above the editor after changes", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      // session_start establishes the UI context for event-driven updates
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      // The mock event bus records without dispatching; drive the subscriber
      // the same way real pi would after each mutation.
      const onChanged = getTodosChangedHandler(mockPi);
      expect(onChanged).toBeDefined();

      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two"] },
        undefined,
        undefined,
        mockCtx,
      );
      onChanged?.();

      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(
        "todos",
        expect.arrayContaining([
          expect.stringContaining("☐"),
          expect.stringContaining("one"),
          expect.stringContaining("two"),
        ]),
      );

      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);
      onChanged?.();
      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      expect(lastCall[0]).toBe("todos");
      expect((lastCall[1] as string[])[0]).toContain("☑");
      expect((lastCall[1] as string[])[1]).toContain("☐");
    });

    it("clears the widget when the list is emptied", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      const onChanged = getTodosChangedHandler(mockPi);

      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one"] },
        undefined,
        undefined,
        mockCtx,
      );
      onChanged?.();
      await tool.execute("call-2", { action: "clear" }, undefined, undefined, mockCtx);
      onChanged?.();

      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith("todos", undefined);
    });

    it("reconstructs and renders persisted todos on session start", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        {
          type: "custom",
          customType: "todos-state",
          data: {
            items: [
              { text: "done task", completed: true },
              { text: "open task", completed: false },
            ],
          },
        },
      ]);
      await todosExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "resume" }, mockCtx);

      expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["done task", "open task"]);
      expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(
        "todos",
        expect.arrayContaining([expect.stringContaining("☑"), expect.stringContaining("☐")]),
      );
    });
  });

  describe("commands", () => {
    it("/todos shows the list", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);

      await getCommandHandler(mockPi, "todos")("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1. ✓ one"), "info");
    });

    it("/todos reports an empty list", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      await getCommandHandler(mockPi, "todos")("", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Todo list is empty.", "info");
    });

    it("/todos:clear empties the list", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one"] },
        undefined,
        undefined,
        mockCtx,
      );

      await getCommandHandler(mockPi, "todos:clear")("", mockCtx);

      expect(getTodoItems(mockPi)).toEqual([]);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Todo list cleared.", "info");
    });
  });
});

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getTool(mockPi: any): any {
  const calls = mockPi.registerTool.mock.calls;
  for (const call of calls) {
    if (call[0].name === "todo") return call[0];
  }
  throw new Error("todo tool not found");
}

/** The todos:changed subscriber, driven manually (mock events don't dispatch). */
// biome-ignore lint/suspicious/noExplicitAny: test mock
function getTodosChangedHandler(mockPi: any): (() => void) | undefined {
  const calls = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "todos:changed") {
      return handler as () => void;
    }
  }
  return undefined;
}
