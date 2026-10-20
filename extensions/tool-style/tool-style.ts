/**
 * Tool Style
 *
 * Adds palette-aware state rails and a computed surface to agent tools, direct
 * shell commands, and extension messages while preserving their behavior.
 */

// --- Imports ---

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BashExecutionComponent,
  CustomMessageComponent,
  Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { installRailStyles, type RailController } from "./src/rails.ts";
import { startWalSurfaceMonitor } from "./src/surface.ts";

// --- Constants ---

const REFRESH_WIDGET_KEY = "tool-style-refresh";

// --- Helpers ---

function refreshUI(ctx: ExtensionContext): void {
  ctx.ui.setWidget(REFRESH_WIDGET_KEY, []);
  ctx.ui.setWidget(REFRESH_WIDGET_KEY, undefined);
}

// --- Extension ---

export default async function toolStyleExtension(pi: ExtensionAPI) {
  let controller: RailController | undefined;
  let stopSurfaceMonitor: (() => void) | undefined;
  let surface: string | undefined;
  let enabled = true;
  const failedRenders = new WeakSet<object>();

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    stopSurfaceMonitor?.();
    stopSurfaceMonitor = undefined;
    controller?.restore();
    surface = undefined;
    controller = installRailStyles(
      { ToolExecutionComponent, BashExecutionComponent, CustomMessageComponent, Theme },
      () => ctx.ui.theme,
      () => surface,
      enabled,
      (instance) => {
        if (failedRenders.has(instance)) return;
        failedRenders.add(instance);
        const name = instance.toolName ?? instance.command;
        ctx.ui.notify(
          name
            ? `Tool style: the "${name}" tool block failed to render and was hidden`
            : "Tool style: a tool block failed to render and was hidden",
          "error",
        );
      },
    );
    stopSurfaceMonitor = startWalSurfaceMonitor({
      onChange(value) {
        surface = value;
        refreshUI(ctx);
      },
      onError(message) {
        ctx.ui.notify(`Tool style: ${message}`, "error");
      },
    });
    refreshUI(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopSurfaceMonitor?.();
    stopSurfaceMonitor = undefined;
    controller?.restore();
    controller = undefined;
  });

  pi.registerCommand("toolstyle:toggle", {
    description: "Toggle state-colored rails on tools, commands, and extension messages",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      enabled = !enabled;
      controller?.setEnabled(enabled);
      refreshUI(ctx);
      ctx.ui.notify(`Tool style ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
