import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTodoItems,
  clearTodoItems,
  getTodoItems,
  markTodoItems,
  reconstructTodos,
  removeCompletedTodoItems,
  setTodoItems,
} from "../../lib/todos.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

describe("todos store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("setTodoItems replaces the list, persists, and publishes", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["  one  ", "", "two"]);

    expect(getTodoItems(mockPi)).toEqual([
      { text: "one", completed: false },
      { text: "two", completed: false },
    ]);
    expect(mockPi.appendEntry).toHaveBeenCalledWith("todos-state", {
      items: [
        { text: "one", completed: false },
        { text: "two", completed: false },
      ],
    });
    expect(mockPi.events.emit).toHaveBeenCalledWith("todos:changed", {
      items: [
        { text: "one", completed: false },
        { text: "two", completed: false },
      ],
    });
  });

  it("addTodoItems appends and returns the added count", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one"]);
    mockPi.appendEntry.mockClear();

    expect(addTodoItems(mockPi, ["two", "", "three"])).toBe(2);
    expect(getTodoItems(mockPi).map((item) => item.text)).toEqual(["one", "two", "three"]);
    expect(mockPi.appendEntry).toHaveBeenCalledWith("todos-state", {
      items: [
        { text: "one", completed: false },
        { text: "two", completed: false },
        { text: "three", completed: false },
      ],
    });
    expect(mockPi.events.emit).toHaveBeenCalledWith("todos:changed", expect.any(Object));
  });

  it("addTodoItems with only empty text does not persist or publish", () => {
    const mockPi = createMockPi();
    expect(addTodoItems(mockPi, ["  "])).toBe(0);
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(mockPi.events.emit).not.toHaveBeenCalled();
  });

  it("markTodoItems checks by 1-based index and reports matches", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one", "two", "three"]);
    mockPi.appendEntry.mockClear();

    expect(markTodoItems(mockPi, [1, 3], true)).toBe(2);
    expect(getTodoItems(mockPi).map((item) => item.completed)).toEqual([true, false, true]);

    // Unchecking
    expect(markTodoItems(mockPi, [1], false)).toBe(1);
    expect(getTodoItems(mockPi)[0]?.completed).toBe(false);

    // Out-of-range and no-op indices
    expect(markTodoItems(mockPi, [99], true)).toBe(0);
    expect(markTodoItems(mockPi, [2], true)).toBe(1);
    expect(markTodoItems(mockPi, [2], true)).toBe(0);
  });

  it("markTodoItems does not persist when nothing changed", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one"]);
    mockPi.appendEntry.mockClear();
    mockPi.events.emit.mockClear();

    markTodoItems(mockPi, [5], true);
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(mockPi.events.emit).not.toHaveBeenCalled();
  });

  it("clearTodoItems empties the list and publishes once", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one", "two"]);
    mockPi.appendEntry.mockClear();
    mockPi.events.emit.mockClear();

    clearTodoItems(mockPi);
    expect(getTodoItems(mockPi)).toEqual([]);
    expect(mockPi.appendEntry).toHaveBeenCalledWith("todos-state", { items: [] });
    expect(mockPi.events.emit).toHaveBeenCalledWith("todos:changed", { items: [] });

    // Clearing an empty list is a no-op
    mockPi.appendEntry.mockClear();
    clearTodoItems(mockPi);
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("removeCompletedTodoItems keeps open items and returns the removed count", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one", "two", "three"]);
    markTodoItems(mockPi, [1, 3], true);
    mockPi.appendEntry.mockClear();
    mockPi.events.emit.mockClear();

    expect(removeCompletedTodoItems(mockPi)).toBe(2);
    expect(getTodoItems(mockPi)).toEqual([{ text: "two", completed: false }]);
    expect(mockPi.appendEntry).toHaveBeenCalledWith("todos-state", {
      items: [{ text: "two", completed: false }],
    });
    expect(mockPi.events.emit).toHaveBeenCalledWith("todos:changed", {
      items: [{ text: "two", completed: false }],
    });
  });

  it("removeCompletedTodoItems with nothing completed is a no-op", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one"]);
    mockPi.appendEntry.mockClear();
    mockPi.events.emit.mockClear();

    expect(removeCompletedTodoItems(mockPi)).toBe(0);
    expect(getTodoItems(mockPi)).toHaveLength(1);
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
    expect(mockPi.events.emit).not.toHaveBeenCalled();
  });

  it("reconstructTodos restores the last persisted snapshot", () => {
    const mockPi = createMockPi();
    reconstructTodos(mockPi, [
      {
        type: "custom",
        customType: "todos-state",
        data: { items: [{ text: "stale", completed: false }] },
      },
      {
        type: "custom",
        customType: "todos-state",
        data: {
          items: [{ text: "current", completed: true }, { text: "junk" }],
        },
      },
    ]);

    // Invalid items are filtered; the last snapshot wins.
    expect(getTodoItems(mockPi)).toEqual([{ text: "current", completed: true }]);
  });

  it("reconstructTodos with no entries leaves the store empty", () => {
    const mockPi = createMockPi();
    setTodoItems(mockPi, ["one"]);
    reconstructTodos(mockPi, [{ type: "message", message: { role: "user", content: "hi" } }]);
    expect(getTodoItems(mockPi)).toEqual([]);
  });
});
