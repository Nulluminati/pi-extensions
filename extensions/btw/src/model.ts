import type { ThinkingLevel } from "pi";
import { loadSmallModelConfig } from "../../../lib/small-model.ts";

export function modelLabel(model: { provider?: string; id: string } | undefined): string {
  if (!model) return "(no model)";
  return `${model.provider ?? "main"}/${model.id}`;
}

export function thinkingLevelToReasoning(
  level: "none" | "low" | "medium" | "high" | null | undefined,
): string | undefined {
  if (!level || level === "none") return undefined;
  return level;
}

export function globalSmallModelDisplay(): { model: string; thinking: ThinkingLevel } {
  try {
    const config = loadSmallModelConfig().config;
    return {
      model: `${config.provider}/${config.model}`,
      thinking: config.thinkingLevel,
    };
  } catch {
    return { model: "(small model not configured)", thinking: "off" };
  }
}

export function resolveThinkingLevel(
  override: "none" | "low" | "medium" | "high" | null,
  configured: ThinkingLevel,
): string {
  if (override) return override;
  return configured === "off" ? "none" : configured;
}
