import type { ThinkingLevel } from "pi";
import { createModelConfigFlow } from "../../../lib/model-picker.ts";
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

// --- Config flow ---

const flow = createModelConfigFlow({
  label: "small",
  pickerTitle: "Small Model",
  selectTitle: "Select Global Small Model",
  loadConfig: loadSmallModelConfig,
  defaultThinkingLevel: "minimal",
  saveConfig: (config) => saveSmallModelConfig(config, resolveSmallModelConfigPath()),
  validate: (config, ctx) => resolveSmallModelFromConfig(ctx, config),
  onApplied: (ctx) => updateStatus(ctx),
});

export const applyConfig = flow.applyConfig;
export const applyThinkingLevel = flow.applyThinkingLevel;
export const currentThinkingLevel = flow.currentThinkingLevel;
export const selectModel = flow.selectModel;

// --- Helpers ---

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
