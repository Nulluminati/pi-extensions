/**
 * Small Model Extension
 *
 * Selects one global model for lightweight extension tasks and publishes the
 * selection in Pi's status area.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import {
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ThinkingLevel } from "pi";
import {
  loadSmallModelConfig,
  parseSmallModelSpec,
  resolveSmallModel,
  resolveSmallModelConfigPath,
  resolveSmallModelFromConfig,
  SMALL_MODEL_ENV_VAR,
  type SmallModelConfig,
  saveSmallModelConfig,
} from "../../lib/small-model.ts";

export const STATUS_ICON = String.fromCodePoint(0xf09d1); // nf-md-brain
const STATUS_KEY = "small-model";
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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

function formatStatus(ctx: ExtensionContext, label: string, thinkingLevel?: ThinkingLevel): string {
  const suffix = thinkingLevel ? ` · ${thinkingLevel}` : "";
  return `${ctx.ui.theme.fg("accent", STATUS_ICON)} ${ctx.ui.theme.fg("muted", `small ${label}${suffix}`)}`;
}

async function updateStatus(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  try {
    const resolved = await resolveSmallModel(ctx);
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatus(
        ctx,
        `${resolved.config.provider}/${resolved.config.model}`,
        resolved.config.thinkingLevel,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const label = message.includes("not configured") ? "not configured" : "unavailable";
    ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx, label));
  }
}

async function applyConfig(
  config: SmallModelConfig,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  try {
    await resolveSmallModelFromConfig(ctx, config);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return false;
  }

  const configPath = resolveSmallModelConfigPath();
  try {
    saveSmallModelConfig(config, configPath);
  } catch (error) {
    ctx.ui.notify(
      `Could not save global small model config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }

  await updateStatus(ctx);
  ctx.ui.notify(
    `Global small model set to ${config.provider}/${config.model} (${config.thinkingLevel}).`,
    "info",
  );
  return true;
}

function currentThinkingLevel(): ThinkingLevel {
  try {
    return loadSmallModelConfig().config.thinkingLevel;
  } catch {
    return "minimal";
  }
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

async function selectModel(ctx: ExtensionCommandContext): Promise<SmallModelConfig | undefined> {
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

function parseCommandConfig(args: string): SmallModelConfig | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const parsed = parseSmallModelSpec(tokens[0] ?? "");
  if (!parsed) return undefined;
  const requestedLevel = tokens[1];
  if (requestedLevel && !THINKING_LEVELS.has(requestedLevel as ThinkingLevel)) return undefined;
  return {
    ...parsed,
    thinkingLevel: requestedLevel ? (requestedLevel as ThinkingLevel) : currentThinkingLevel(),
  };
}

export default async function smallModelExtension(pi: ExtensionAPI) {
  let configWatcher: FSWatcher | undefined;
  let watcherDebounce: ReturnType<typeof setTimeout> | undefined;

  function stopWatching(): void {
    if (watcherDebounce) {
      clearTimeout(watcherDebounce);
      watcherDebounce = undefined;
    }
    configWatcher?.close();
    configWatcher = undefined;
  }

  function startWatching(ctx: ExtensionContext): void {
    stopWatching();
    const configPath = resolveSmallModelConfigPath();
    const configDirectory = dirname(configPath);
    mkdirSync(configDirectory, { recursive: true });
    configWatcher = watch(configDirectory, (_event, filename) => {
      if (filename && filename.toString() !== basename(configPath)) return;
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        watcherDebounce = undefined;
        void updateStatus(ctx);
      }, 25);
    });
  }

  pi.registerCommand("small-model", {
    description: "Select the global model used by lightweight extension tasks",
    handler: async (args, ctx) => {
      if (process.env[SMALL_MODEL_ENV_VAR]?.trim()) {
        ctx.ui.notify(
          `${SMALL_MODEL_ENV_VAR} is overriding the global config. Unset it before using /small-model.`,
          "warning",
        );
        await updateStatus(ctx);
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "show") {
        try {
          const loaded = loadSmallModelConfig();
          ctx.ui.notify(
            `Global small model is ${loaded.config.provider}/${loaded.config.model} (${loaded.config.thinkingLevel}, ${loaded.source}).`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const config = trimmed ? parseCommandConfig(trimmed) : await selectModel(ctx);
      if (!config) {
        if (trimmed) {
          ctx.ui.notify(
            "Usage: /small-model [provider/model-id [off|minimal|low|medium|high|xhigh|max] | show]",
            "warning",
          );
        }
        return;
      }
      await applyConfig(config, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await updateStatus(ctx);
    startWatching(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopWatching();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
