import type { SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { formatModelDescription, selectModelWithSearch } from "../../../lib/model-picker.ts";
import {
  loadSmallModelConfig,
  parseSmallModelSpec,
  type SmallModelConfig,
} from "../../../lib/small-model.ts";
import { currentThinkingLevel } from "./config.ts";

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
      ? await selectModelWithSearch(ctx, items, activeValue, "Small Model")
      : await ctx.ui.select(
          "Select Global Small Model",
          items.map((item) => item.value),
        );
  if (!selected) return undefined;
  const parsed = parseSmallModelSpec(selected);
  if (!parsed) return undefined;
  return { ...parsed, thinkingLevel: currentThinkingLevel() };
}
