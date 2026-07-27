import {
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { parseSmallModelSpec, type SmallModelConfig } from "../../../lib/small-model.ts";
import { currentThinkingLevel } from "./config.ts";

interface ModelMetadata {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

function formatTokenCount(value: number): string {
  const units =
    value >= 1_000_000 ? { divisor: 1_000_000, suffix: "m" } : { divisor: 1_000, suffix: "k" };
  const scaled = Math.round((value / units.divisor) * 10) / 10;
  return `${scaled}${units.suffix}`;
}

function formatModelDescription(model: ModelMetadata): string {
  const details = [
    `${formatTokenCount(model.contextWindow)} ctx`,
    `${formatTokenCount(model.maxTokens)} out`,
  ];
  if (model.input.includes("image")) details.push("image");
  if (model.reasoning) details.push("reasoning");
  return model.name === model.id ? details.join(" · ") : `${model.name} · ${details.join(" · ")}`;
}

async function selectModelWithSearch(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const searchInput = new Input();
    let filteredItems = items;
    let selectedIndex = 0;
    let focused = false;

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (_text: string) => theme.fg("warning", "  No matching models"),
    };
    let selectList = new SelectList(filteredItems, Math.min(items.length, 12), listTheme);

    function refreshFilter(): void {
      const query = searchInput.getValue().trim();
      filteredItems = query
        ? fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`)
        : items;
      selectedIndex = 0;
      selectList = new SelectList(
        filteredItems,
        Math.min(Math.max(filteredItems.length, 1), 12),
        listTheme,
      );
    }

    function moveSelection(offset: number): void {
      if (filteredItems.length === 0) return;
      selectedIndex = (selectedIndex + offset + filteredItems.length) % filteredItems.length;
      selectList.setSelectedIndex(selectedIndex);
    }

    return {
      get focused(): boolean {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        searchInput.focused = value;
      },
      render(width: number): string[] {
        const safeWidth = Math.max(width, 1);
        const searchPrefix = theme.fg("muted", "Search: ");
        const inputWidth = Math.max(safeWidth - visibleWidth(searchPrefix), 1);
        const inputLine = searchInput.render(inputWidth)[0] ?? "";
        return [
          truncateToWidth(
            theme.fg("accent", theme.bold("Select global small model")),
            safeWidth,
            "",
          ),
          truncateToWidth(`${searchPrefix}${inputLine}`, safeWidth, ""),
          ...selectList.render(safeWidth),
          truncateToWidth(
            theme.fg("dim", "type to search · ↑↓ navigate · enter select · esc cancel"),
            safeWidth,
            "",
          ),
        ];
      },
      invalidate(): void {
        searchInput.invalidate();
        selectList.invalidate();
      },
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.up")) {
          moveSelection(-1);
        } else if (keybindings.matches(data, "tui.select.down")) {
          moveSelection(1);
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          const selected = filteredItems[selectedIndex];
          if (selected) done(selected.value);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else {
          searchInput.handleInput(data);
          refreshFilter();
        }
        tui.requestRender();
      },
    };
  });
}

export async function selectModel(
  ctx: ExtensionCommandContext,
): Promise<SmallModelConfig | undefined> {
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.provider && model.input.includes("text"))
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const items: SelectItem[] = models.map((model) => {
    const value = `${model.provider}/${model.id}`;
    return { value, label: value, description: formatModelDescription(model) };
  });
  if (items.length === 0) {
    ctx.ui.notify("No authenticated text models are available.", "error");
    return undefined;
  }

  const selected =
    ctx.mode === "tui"
      ? await selectModelWithSearch(ctx, items)
      : await ctx.ui.select(
          "Select global small model",
          items.map((item) => item.value),
        );
  if (!selected) return undefined;
  const parsed = parseSmallModelSpec(selected);
  if (!parsed) return undefined;
  return { ...parsed, thinkingLevel: currentThinkingLevel() };
}
