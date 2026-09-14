/**
 * Shared model-picker pieces for `/smallmodel`- and `/worker-model`-style
 * config commands: token-count formatting, model description building, and
 * the searchable modal used in TUI mode. Config loading/saving itself lives
 * in lib/small-model.ts and lib/worker-model.ts.
 */

import type { SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { createSearchableSelectModal } from "./searchable-select.ts";

// --- Types ---

export interface ModelMetadata {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

// --- Formatting ---

export function formatTokenCount(value: number): string {
  const units =
    value >= 1_000_000 ? { divisor: 1_000_000, suffix: "m" } : { divisor: 1_000, suffix: "k" };
  const scaled = Math.round((value / units.divisor) * 10) / 10;
  return `${scaled}${units.suffix}`;
}

export function formatModelDescription(model: ModelMetadata): string {
  const details = [
    `${formatTokenCount(model.contextWindow)} ctx`,
    `${formatTokenCount(model.maxTokens)} out`,
  ];
  if (model.input.includes("image")) details.push("image");
  if (model.reasoning) details.push("reasoning");
  return model.name === model.id ? details.join(" · ") : `${model.name} · ${details.join(" · ")}`;
}

// --- Picker ---

/**
 * Show the searchable model picker in TUI mode; resolves the selected item's
 * value, or undefined when cancelled. `title` names the dialog ("Small
 * Model", "Worker Model").
 */
export async function selectModelWithSearch(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
  activeValue: string | undefined,
  title: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    createSearchableSelectModal({
      tui,
      theme,
      keybindings,
      items,
      activeValue,
      title,
      maxVisible: 10,
      noMatchText: "No matching models",
      searchText: (item) => `${item.value} ${item.description ?? ""}`,
      onSelect: done,
      onCancel: () => done(undefined),
    }),
  );
}
