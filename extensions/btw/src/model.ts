import type { ExtensionContext, ThinkingLevel } from "pi";
import { resolveSmallModel } from "../../../lib/small-model.ts";

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

export interface SmallModelDisplay {
  model: string;
  thinking: ThinkingLevel;
}

const NOT_CONFIGURED_DISPLAY: SmallModelDisplay = {
  model: "(small model not configured)",
  thinking: "off",
};

/**
 * Resolve the small-model config line (label + inherited thinking level)
 * through resolveSmallModel. Display-only call sites degrade gracefully to
 * the not-configured label when resolution fails.
 */
export async function resolveSmallModelDisplay(ctx: ExtensionContext): Promise<SmallModelDisplay> {
  try {
    const resolved = await resolveSmallModel(ctx);
    return {
      model: `${resolved.config.provider}/${resolved.config.model}`,
      thinking: resolved.config.thinkingLevel,
    };
  } catch {
    return NOT_CONFIGURED_DISPLAY;
  }
}

export function resolveThinkingLevel(
  override: "none" | "low" | "medium" | "high" | null,
  configured: ThinkingLevel,
): string {
  if (override) return override;
  return configured === "off" ? "none" : configured;
}
