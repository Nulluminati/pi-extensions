import type { SelectItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createSearchableSelectModal, SearchableSelect } from "../../lib/searchable-select.ts";

const ITEMS: SelectItem[] = [
  { value: "brave", label: "Brave Search", description: "Independent web index" },
  { value: "synthetic", label: "Synthetic", description: "Search for coding agents" },
];

function createSelector(
  overrides: { onSelect?: (value: string) => void; onCancel?: () => void } = {},
) {
  const requestRender = vi.fn();
  const onSelect = overrides.onSelect ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  const selector = new SearchableSelect({
    tui: { requestRender },
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
    keybindings: { matches: matchesKey },
    items: ITEMS,
    title: "Select provider",
    maxVisible: 10,
    noMatchText: "No matching providers",
    onSelect,
    onCancel,
  });
  return { selector, requestRender, onSelect, onCancel };
}

describe("SearchableSelect", () => {
  it("renders a title, search input, items, and standard help", () => {
    const { selector } = createSelector();
    const rendered = selector.render(80).join("\n");

    expect(rendered).toContain("Select provider");
    expect(rendered).toContain("Search:");
    expect(rendered).toContain("Brave Search");
    expect(rendered).toContain("Synthetic");
    expect(rendered).toContain("type: search · ↑↓: navigate · enter: select · esc: cancel");
  });

  it("renders no lines when no width is available", () => {
    const { selector } = createSelector();

    expect(selector.render(0)).toEqual([]);
  });

  it("highlights the active item without changing its label", () => {
    const selector = new SearchableSelect({
      tui: { requestRender: vi.fn() },
      theme: {
        fg: (color, text) => `<${color}>${text}</${color}>`,
        bold: (text) => text,
      },
      keybindings: { matches: matchesKey },
      items: ITEMS,
      activeValue: "brave",
      title: "Select provider",
      maxVisible: 10,
      noMatchText: "No matching providers",
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("<accent>Brave Search</accent>");
    expect(rendered).not.toContain("(active)");
  });

  it("filters against labels, values, and descriptions", () => {
    const { selector } = createSelector();

    for (const character of "coding") selector.handleInput(character);

    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("Synthetic");
    expect(rendered).not.toContain("Brave Search");
  });

  it("moves through filtered results and selects the highlighted value", () => {
    const onSelect = vi.fn();
    const { selector } = createSelector({ onSelect });

    selector.handleInput("down");
    selector.handleInput("enter");

    expect(onSelect).toHaveBeenCalledWith("synthetic");
  });

  it("cancels through the configured selection keybinding", () => {
    const onCancel = vi.fn();
    const { selector } = createSelector({ onCancel });

    selector.handleInput("escape");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("creates the bordered modal presentation used by extension pickers", () => {
    const requestRender = vi.fn();
    const modal = createSearchableSelectModal({
      tui: { requestRender },
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
      },
      keybindings: { matches: matchesKey },
      items: ITEMS,
      title: "Select provider",
      maxVisible: 10,
      noMatchText: "No matching providers",
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = modal.render(20);
    expect(lines[0]).toBe("╭──────────────────╮");
    expect(lines.at(-1)).toBe("╰──────────────────╯");
    expect(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(
      true,
    );
    modal.focused = true;
    modal.handleInput("s");
    expect(modal.focused).toBe(true);
    expect(requestRender).toHaveBeenCalled();
  });

  it("propagates focus and requests rendering after input", () => {
    const { selector, requestRender } = createSelector();

    selector.focused = true;
    selector.handleInput("s");

    expect(selector.focused).toBe(true);
    expect(requestRender).toHaveBeenCalled();
  });
});

function matchesKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string> = {
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.select.confirm": "enter",
    "tui.select.cancel": "escape",
  };
  return keys[keybinding] === data;
}
