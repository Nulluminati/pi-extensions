import type { ExtensionCommandContext, ThinkingLevel } from "pi";
import {
  loadSmallModelConfig,
  parseSmallModelSpec,
  resolveSmallModelConfigPath,
  resolveSmallModelFromConfig,
  type SmallModelConfig,
  saveSmallModelConfig,
} from "../../../lib/small-model.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { updateStatus } from "./status.ts";

export async function applyConfig(
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

export function currentThinkingLevel(): ThinkingLevel {
  try {
    return loadSmallModelConfig().config.thinkingLevel;
  } catch {
    return "minimal";
  }
}

export function parseCommandConfig(args: string): SmallModelConfig | undefined {
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
