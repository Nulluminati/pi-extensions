import type { SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { createSearchableSelectModal } from "../../../lib/searchable-select.ts";
import {
  loadSmallModelConfig,
  parseSmallModelSpec,
  type SmallModelConfig,
} from "../../../lib/small-model.ts";
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
  activeValue: string | undefined,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    createSearchableSelectModal({
      tui,
      theme,
      keybindings,
      items,
      activeValue,
      title: "Small Model",
      maxVisible: 10,
      noMatchText: "No matching models",
      searchText: (item) => `${item.value} ${item.description ?? ""}`,
      onSelect: done,
      onCancel: () => done(undefined),
    }),
  );
}

export async function selectModel(
  ctx: ExtensionCommandContext,
): Promise<SmallModelConfig | undefined> {
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.provider && model.input.includes("text"))
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  let activeValue: string | undefined;
  try {
    const active = loadSmallModelConfig().config;
    activeValue = `${active.provider}/${active.model}`;
  } catch {
    activeValue = undefined;
  }

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
      ? await selectModelWithSearch(ctx, items, activeValue)
      : await ctx.ui.select(
          "Select Global Small Model",
          items.map((item) => item.value),
        );
  if (!selected) return undefined;
  const parsed = parseSmallModelSpec(selected);
  if (!parsed) return undefined;
  return { ...parsed, thinkingLevel: currentThinkingLevel() };
}
