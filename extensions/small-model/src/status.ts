import type { ExtensionContext, ThinkingLevel } from "pi";
import { resolveSmallModel } from "../../../lib/small-model.ts";
import { STATUS_ICON, STATUS_KEY } from "./constants.ts";

function formatStatus(ctx: ExtensionContext, label: string, thinkingLevel?: ThinkingLevel): string {
  const suffix = thinkingLevel ? ` · ${thinkingLevel}` : "";
  return `${ctx.ui.theme.fg("accent", STATUS_ICON)} ${ctx.ui.theme.fg("muted", `small ${label}${suffix}`)}`;
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
