import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/**
 * Publishes the resolved small model in the status area. `isCurrent` lets a
 * caller drop the write when the session ended while the model resolved.
 */
export async function updateStatus(
  ctx: ExtensionContext,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!ctx.hasUI) return;
  try {
    const resolved = await resolveSmallModel(ctx);
    if (!isCurrent()) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatus(
        ctx,
        `${resolved.config.provider}/${resolved.config.model}`,
        resolved.config.thinkingLevel,
      ),
    );
  } catch (error) {
    if (!isCurrent()) return;
    const message = error instanceof Error ? error.message : String(error);
    const label = message.includes("not configured") ? "not configured" : "unavailable";
    ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx, label));
  }
}
