import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Check } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import todosExtension from "../../extensions/todos/todos.ts";
import { getTodoItems } from "../../lib/todos.ts";
import { STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
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
      expect(sourceFiles.filter((file) => file.endsWith(".ts")).sort()).toEqual([
        "panel.ts",
        "widget.ts",
      ]);
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
    expect(commands).toEqual(["todos", "todos:clear", "todos:clear-completed"]);
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

    it.each([
      [{ action: "list" }, "Todo list is empty.", undefined],
      [{ action: "clear" }, "Todo list cleared.", undefined],
      [
        { action: "add", items: [] },
        "No items to add: provide at least one non-empty item.",
        "no_items",
      ],
      [
        { action: "check" },
        "No item numbers provided for action check. Provide ids matching the list returned by this tool.",
        "no_ids",
      ],
      [
        { action: "uncheck" },
        "No item numbers provided for action uncheck. Provide ids matching the list returned by this tool.",
        "no_ids",
      ],
      [
        { action: "invalid" },
        "Unknown todo action: invalid. Use add, check, uncheck, clear, or list.",
        "unknown_action",
      ],
    ])("returns structured data and unchanged text for %j", async (params, text, error) => {
      const mockPi = createMockPi();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      const result = await tool.execute(
        "data",
        params,
        undefined,
        undefined,
        createMockCommandContext(),
      );
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ items: [], ...(error ? { error } : {}) });
      expect(result.content).toEqual([{ type: "text", text }]);
      expect(result.isError).toBe(error ? true : undefined);
      expect(result.terminate).toBe(error ? true : undefined);
    });

    it("returns numbered structured items after each mutation", async () => {
      const mockPi = createMockPi();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      const ctx = createMockCommandContext();
      for (const [params, completed, text] of [
        [{ action: "add", items: ["first"] }, false, "Added 1 item(s):\n1. ☐ first"],
        [{ action: "check", ids: [1] }, true, "Marked 1 item(s):\n1. ☑ first"],
        [{ action: "uncheck", ids: [1] }, false, "Marked 1 item(s):\n1. ☐ first"],
        [{ action: "check", ids: [9] }, false, "No items matched the given numbers:\n1. ☐ first"],
        [{ action: "list" }, false, "1. ☐ first"],
      ] as const) {
        const result = await tool.execute("data", params, undefined, undefined, ctx);
        expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
        expect(result.structuredContent).toEqual({ items: [{ id: 1, text: "first", completed }] });
        expect(result.details).toEqual({ items: [{ text: "first", completed }] });
        expect(result.content).toEqual([{ type: "text", text }]);
        expect(result.isError).toBeUndefined();
        expect(result.terminate).toBeUndefined();
      }
    });

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
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    function renderLastWidget(mockCtx: any, width = 80): string[] {
      const lastCall = mockCtx.ui.setWidget.mock.calls.at(-1) as unknown[];
      const factory = lastCall[1] as
        | ((
            tui: unknown,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
            theme: any,
          ) => { render(w: number): string[] })
        | undefined;
      if (typeof factory !== "function") {
        throw new Error(`expected a widget factory, got ${String(factory)}`);
      }
      return factory(undefined, mockCtx.ui.theme).render(width);
    }

    it("renders the list in a framed box with a progress label", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      const onChanged = getTodosChangedHandler(mockPi);

      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two"] },
        undefined,
        undefined,
        mockCtx,
      );
      onChanged?.();

      const lines = renderLastWidget(mockCtx);
      expect(lines[0]?.startsWith("╭")).toBe(true);
      expect(lines.at(-1)?.startsWith("╰")).toBe(true);
      expect(lines.join("\n")).toContain("Todos");
      expect(lines.join("\n")).toContain("0/2 done");
      expect(lines.join("\n")).toContain("☐ one");
      expect(lines.join("\n")).toContain("☐ two");

      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);
      onChanged?.();
      expect(renderLastWidget(mockCtx).join("\n")).toContain("1/2 done");
    });

    it("hides completed items while open items remain", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      const onChanged = getTodosChangedHandler(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two", "three", "four"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1, 2] }, undefined, undefined, mockCtx);
      onChanged?.();

      const text = renderLastWidget(mockCtx).join("\n");
      expect(text).toContain("2/4 done");
      expect(text).not.toContain("☑ one");
      expect(text).not.toContain("☑ two");
      expect(text).toContain("☐ three");
      expect(text).toContain("☐ four");
    });

    it("keeps finished items visible when everything is complete", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      const onChanged = getTodosChangedHandler(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1, 2] }, undefined, undefined, mockCtx);
      onChanged?.();

      const text = renderLastWidget(mockCtx).join("\n");
      expect(text).toContain("2/2 done");
      expect(text).toContain("☑ one");
      expect(text).toContain("☑ two");
    });

    it("truncates the list to three items with a more indicator", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, mockCtx);
      const onChanged = getTodosChangedHandler(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two", "three", "four", "five"] },
        undefined,
        undefined,
        mockCtx,
      );
      onChanged?.();

      const text = renderLastWidget(mockCtx).join("\n");
      expect(text).toContain("☐ one");
      expect(text).toContain("☐ three");
      expect(text).not.toContain("four");
      expect(text).toContain("↓ 2 more");
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

      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
    });

    it("does not churn its widget when the recap appears (strip owns ordering)", async () => {
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
      mockCtx.ui.setWidget.mockClear();

      const onRecapChanged = mockPi.events.on.mock.calls.find(
        ([event]) => event === "recap:changed",
      );
      // The strip owns ordering — no recap-driven churn listener, and recap
      // events leave this widget untouched.
      expect(onRecapChanged).toBeUndefined();
      expect(mockCtx.ui.setWidget).not.toHaveBeenCalled();
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
      const text = renderLastWidget(mockCtx).join("\n");
      expect(text).toContain("1/2 done");
      expect(text).toContain("☐ open task");
    });
  });

  describe("commands", () => {
    const NULL_KEYBINDINGS = { matches: () => false };

    it("/todos opens a framed panel listing every item", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["done thing", "open thing"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let component: any;
      mockCtx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (factory: any) =>
          new Promise<void>((resolve) => {
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              mockCtx.ui.theme,
              NULL_KEYBINDINGS,
              resolve,
            );
          }),
      );

      const pending = getCommandHandler(mockPi, "todos")("", mockCtx);

      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(mockCtx.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center" },
      });
      const lines = component.render(80).join("\n");
      expect(lines).toContain("Todos");
      expect(lines).toContain("1/2 done");
      expect(lines).toContain("1. ☑ done thing");
      expect(lines).toContain("2. ☐ open thing");
      expect(lines).toContain("c: clear done");

      component.handleInput("\r");
      await pending;
    });

    it("/todos panel renders an empty state", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let component: any;
      mockCtx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (factory: any) =>
          new Promise<void>((resolve) => {
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              mockCtx.ui.theme,
              NULL_KEYBINDINGS,
              resolve,
            );
          }),
      );

      const pending = getCommandHandler(mockPi, "todos")("", mockCtx);

      const lines = component.render(80).join("\n");
      expect(lines).toContain("No items yet.");
      expect(lines).not.toContain("0/0 done");

      component.handleInput("\r");
      await pending;
    });

    it("/todos panel `c` removes completed items and re-renders live", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["a", "b"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1] }, undefined, undefined, mockCtx);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let component: any;
      mockCtx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (factory: any) =>
          new Promise<void>((resolve) => {
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              mockCtx.ui.theme,
              NULL_KEYBINDINGS,
              resolve,
            );
          }),
      );
      const pending = getCommandHandler(mockPi, "todos")("", mockCtx);

      component.handleInput("c");

      expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["b"]);
      const after = component.render(80).join("\n");
      expect(after).not.toContain("1. ☑ a");
      expect(after).toContain("1. ☐ b");

      component.handleInput("q");
      await pending;
    });

    it("/todos panel closes on esc via the keybindings manager", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let component: any;
      const done = vi.fn();
      mockCtx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (factory: any) =>
          new Promise<void>(() => {
            const keybindings = {
              bindings: { "\u001b": ["tui.select.cancel"] } as Record<string, string[]>,
              matches(data: string, keybinding: string) {
                return (this.bindings[data] ?? []).includes(keybinding);
              },
            };
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              mockCtx.ui.theme,
              keybindings,
              done,
            );
          }),
      );

      void getCommandHandler(mockPi, "todos")("", mockCtx);
      component.handleInput("\u001b");
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("/todos does nothing without a UI", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await todosExtension(mockPi);

      await getCommandHandler(mockPi, "todos")("", mockCtx);

      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
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

    it("/todos:clear-completed removes only completed items", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await todosExtension(mockPi);
      const tool = getTool(mockPi);
      await tool.execute(
        "call-1",
        { action: "add", items: ["one", "two", "three"] },
        undefined,
        undefined,
        mockCtx,
      );
      await tool.execute("call-2", { action: "check", ids: [1, 3] }, undefined, undefined, mockCtx);

      await getCommandHandler(mockPi, "todos:clear-completed")("", mockCtx);

      expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["two"]);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Removed 2 completed item(s).", "info");
    });

    it("/todos:clear-completed reports when nothing is completed", async () => {
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

      await getCommandHandler(mockPi, "todos:clear-completed")("", mockCtx);

      expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["one"]);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("No completed items to remove.", "info");
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
