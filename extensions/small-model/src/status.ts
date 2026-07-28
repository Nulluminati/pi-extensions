import type { ExtensionContext, ThinkingLevel } from "pi";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { formatStatusLine } from "../../../lib/ui-format.ts";
import { STATUS_ICON, STATUS_KEY } from "./constants.ts";

function formatStatus(ctx: ExtensionContext, label: string, thinkingLevel?: ThinkingLevel): string {
  const suffix = thinkingLevel ? ` · ${thinkingLevel}` : "";
  return formatStatusLine(ctx.ui.theme, {
    icon: STATUS_ICON,
    prefix: "Small Model",
    text: `${label}${suffix}`,
  });
}

export async function updateStatus(ctx: ExtensionContext): Promise<void> {
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
