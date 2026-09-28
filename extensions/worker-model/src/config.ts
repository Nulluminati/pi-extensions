import type { ExtensionCommandContext, ThinkingLevel } from "pi";
import {
  DEFAULT_WORKER_THINKING_LEVEL,
  isWorkerThinkingLevel,
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  saveWorkerModelConfig,
  type WorkerModelConfig,
} from "../../../lib/worker-model.ts";

export function parseWorkerModelSpec(args: string): WorkerModelConfig | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return undefined;
  const [provider, ...rest] = (tokens[0] ?? "").split("/");
  if (!provider || rest.length === 0 || rest.some((part) => !part.trim())) return undefined;
  const requestedLevel = tokens[1];
  let thinkingLevel = currentWorkerThinkingLevel();
  if (requestedLevel !== undefined) {
    if (!isWorkerThinkingLevel(requestedLevel)) return undefined;
    thinkingLevel = requestedLevel;
  }
  return {
    provider: provider.trim(),
    model: rest.join("/").trim(),
    thinkingLevel,
  };
}

export async function applyWorkerConfig(
  config: WorkerModelConfig,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const configPath = resolveWorkerModelConfigPath();
  try {
    await saveWorkerModelConfig(config, configPath);
  } catch (error) {
    ctx.ui.notify(
      `Could not save global worker model config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }

  ctx.ui.notify(
    `Global worker model set to ${config.provider}/${config.model} (${config.thinkingLevel}).`,
    "info",
  );
  return true;
}

export async function applyWorkerThinkingLevel(
  thinkingLevel: ThinkingLevel,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  let current: WorkerModelConfig;
  try {
    current = loadWorkerModelConfig().config;
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return false;
  }
  return applyWorkerConfig({ ...current, thinkingLevel }, ctx);
}

export function currentWorkerThinkingLevel(): ThinkingLevel {
  try {
    return loadWorkerModelConfig().config.thinkingLevel;
  } catch {
    return DEFAULT_WORKER_THINKING_LEVEL;
  }
}

export function configuredWorkerModelLabel(): string | undefined {
  try {
    return `${loadWorkerModelConfig().config.provider}/${loadWorkerModelConfig().config.model}`;
  } catch {
    return undefined;
  }
}
