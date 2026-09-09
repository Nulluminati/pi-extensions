import type { ExtensionContext } from "pi";
import { formatStatusLine } from "../../../lib/ui-format.ts";
import { loadWorkerModelConfig } from "../../../lib/worker-model.ts";
import { STATUS_ICON, STATUS_KEY } from "./constants.ts";

function formatStatus(ctx: ExtensionContext, label: string): string {
  return formatStatusLine(ctx.ui.theme, {
    icon: STATUS_ICON,
    prefix: "Worker Model",
    text: label,
  });
}

export async function updateStatus(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  try {
    const loaded = loadWorkerModelConfig();
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatus(ctx, `${loaded.config.provider}/${loaded.config.model}`),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const label = message.includes("not configured") ? "not configured" : "unavailable";
    ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx, label));
  }
}
