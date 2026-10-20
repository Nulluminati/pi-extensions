/**
 * Shared model-picker pieces for `/smallmodel`- and `/worker-model`-style
 * config commands: token-count formatting, model description building, the
 * searchable modal used in TUI mode, and the select/apply config flow shared
 * by the small-model and worker-model extensions. Config loading/saving itself
 * lives in lib/small-model.ts and lib/worker-model.ts.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { createSearchableSelectModal } from "./searchable-select.ts";
import { parseSmallModelSpec } from "./small-model.ts";
import { formatTokenCount } from "./token-count.ts";

export { formatTokenCount } from "./token-count.ts";

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

export function formatModelDescription(model: ModelMetadata): string {
  const details = [
    `${formatTokenCount(model.contextWindow)} ctx`,
    `${formatTokenCount(model.maxTokens)} out`,
  ];
  if (model.input.includes("image")) details.push("image");
  if (model.reasoning) details.push("reasoning");
  return model.name === model.id ? details.join(" · ") : `${model.name} · ${details.join(" · ")}`;
}

// --- Config flow ---

/** The provider/model/thinking-level triple a config flow stores. Both
 *  lib/small-model.ts's SmallModelConfig and lib/worker-model.ts's
 *  WorkerModelConfig satisfy this shape. */
export interface ModelConfigValue {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ModelConfigFlowOptions {
  /** Noun used in user-facing messages, e.g. "small" or "worker". */
  label: string;
  /** TUI searchable-modal title, e.g. "Small Model". */
  pickerTitle: string;
  /** Non-TUI select prompt, e.g. "Select Global Small Model". */
  selectTitle: string;
  /** Load the stored config. Throws when unconfigured or malformed. */
  loadConfig(): { config: ModelConfigValue };
  /** Thinking level for new selections and unconfigured configs. */
  defaultThinkingLevel: ThinkingLevel;
  /** Persist the config; may be sync or async. */
  saveConfig(config: ModelConfigValue): unknown;
  /** Reject configs whose model is unavailable or unauthenticated. Throws
   *  with a user-facing message; saving is skipped. */
  validate?(config: ModelConfigValue, ctx: ExtensionCommandContext): unknown;
  /** Publish extension state after a successful save, before the
   *  confirmation toast. */
  onApplied?(ctx: ExtensionCommandContext): unknown;
}

export interface ModelConfigFlow {
  selectModel(ctx: ExtensionCommandContext): Promise<ModelConfigValue | undefined>;
  applyConfig(config: ModelConfigValue, ctx: ExtensionCommandContext): Promise<boolean>;
  applyThinkingLevel(thinkingLevel: ThinkingLevel, ctx: ExtensionCommandContext): Promise<boolean>;
  currentThinkingLevel(): ThinkingLevel;
}

/**
 * The `/smallmodel`- and `/worker-model`-style config flow: interactive model
 * selection (searchable modal in TUI, plain select otherwise), pre-save
 * validation, config persistence, thinking-level updates, and the confirmation
 * toast. Extensions supply their loader, saver, titles, and optional
 * validate/onApplied hooks; provider validation and storage stay in
 * lib/small-model.ts and lib/worker-model.ts.
 */
export function createModelConfigFlow(options: ModelConfigFlowOptions): ModelConfigFlow {
  function currentThinkingLevel(): ThinkingLevel {
    try {
      return options.loadConfig().config.thinkingLevel;
    } catch {
      return options.defaultThinkingLevel;
    }
  }

  async function selectModel(ctx: ExtensionCommandContext): Promise<ModelConfigValue | undefined> {
    const models = ctx.modelRegistry
      .getAvailable()
      .filter((model) => model.provider && model.input.includes("text"))
      .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
    let activeValue: string | undefined;
    try {
      const active = options.loadConfig().config;
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
        ? await selectModelWithSearch(ctx, items, activeValue, options.pickerTitle)
        : await ctx.ui.select(
            options.selectTitle,
            items.map((item) => item.value),
          );
    if (!selected) return undefined;
    const parsed = parseSmallModelSpec(selected);
    if (!parsed) return undefined;
    return { ...parsed, thinkingLevel: currentThinkingLevel() };
  }

  async function applyConfig(
    config: ModelConfigValue,
    ctx: ExtensionCommandContext,
  ): Promise<boolean> {
    if (options.validate) {
      try {
        await options.validate(config, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    }

    try {
      await options.saveConfig(config);
    } catch (error) {
      ctx.ui.notify(
        `Could not save global ${options.label} model config: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }

    if (options.onApplied) await options.onApplied(ctx);
    ctx.ui.notify(
      `Global ${options.label} model set to ${config.provider}/${config.model} (${config.thinkingLevel}).`,
      "info",
    );
    return true;
  }

  async function applyThinkingLevel(
    thinkingLevel: ThinkingLevel,
    ctx: ExtensionCommandContext,
  ): Promise<boolean> {
    let current: ModelConfigValue;
    try {
      current = options.loadConfig().config;
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
    return applyConfig({ ...current, thinkingLevel }, ctx);
  }

  return { selectModel, applyConfig, applyThinkingLevel, currentThinkingLevel };
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
