import { createModelConfigFlow } from "../../../lib/model-picker.ts";
import {
  DEFAULT_WORKER_THINKING_LEVEL,
  isWorkerThinkingLevel,
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  saveWorkerModelConfig,
  type WorkerModelConfig,
} from "../../../lib/worker-model.ts";

// --- Config flow ---

const flow = createModelConfigFlow({
  label: "worker",
  pickerTitle: "Worker Model",
  selectTitle: "Select Global Worker Model",
  loadConfig: loadWorkerModelConfig,
  defaultThinkingLevel: DEFAULT_WORKER_THINKING_LEVEL,
  saveConfig: (config) => saveWorkerModelConfig(config, resolveWorkerModelConfigPath()),
});

export const applyWorkerConfig = flow.applyConfig;
export const applyWorkerThinkingLevel = flow.applyThinkingLevel;
export const currentWorkerThinkingLevel = flow.currentThinkingLevel;
export const selectWorkerModel = flow.selectModel;

// --- Helpers ---

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

export function configuredWorkerModelLabel(): string | undefined {
  try {
    return `${loadWorkerModelConfig().config.provider}/${loadWorkerModelConfig().config.model}`;
  } catch {
    return undefined;
  }
}
