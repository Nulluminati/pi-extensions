import type { ExtensionCommandContext } from "pi";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  saveWorkerModelConfig,
  type WorkerModelConfig,
} from "../../../lib/worker-model.ts";
import { updateStatus } from "./status.ts";

export function parseWorkerModelSpec(args: string): WorkerModelConfig | undefined {
  const [provider, ...rest] = args.trim().split("/");
  if (!provider || rest.length === 0 || rest.some((part) => !part.trim())) return undefined;
  return { provider: provider.trim(), model: rest.join("/").trim() };
}

export async function applyWorkerConfig(
  config: WorkerModelConfig,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const configPath = resolveWorkerModelConfigPath();
  try {
    saveWorkerModelConfig(config, configPath);
  } catch (error) {
    ctx.ui.notify(
      `Could not save global worker model config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }

  await updateStatus(ctx);
  ctx.ui.notify(`Global worker model set to ${config.provider}/${config.model}.`, "info");
  return true;
}

export function configuredWorkerModelLabel(): string | undefined {
  try {
    return `${loadWorkerModelConfig().config.provider}/${loadWorkerModelConfig().config.model}`;
  } catch {
    return undefined;
  }
}
