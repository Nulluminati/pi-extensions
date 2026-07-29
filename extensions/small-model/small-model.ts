/**
 * Small Model Extension
 *
 * Selects one global model for lightweight extension tasks and publishes the
 * selection in Pi's status area.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import {
  loadSmallModelConfig,
  resolveSmallModelConfigPath,
  SMALL_MODEL_ENV_VAR,
} from "../../lib/small-model.ts";
import { applyConfig, parseCommandConfig } from "./src/config.ts";
import { STATUS_ICON, STATUS_KEY } from "./src/constants.ts";
import { selectModel } from "./src/picker.ts";
import { updateStatus } from "./src/status.ts";

export { STATUS_ICON };

// --- Extension ---

export default async function smallModelExtension(pi: ExtensionAPI) {
  let configWatcher: FSWatcher | undefined;
  let watcherDebounce: ReturnType<typeof setTimeout> | undefined;

  function stopWatching(): void {
    if (watcherDebounce) {
      clearTimeout(watcherDebounce);
      watcherDebounce = undefined;
    }
    configWatcher?.close();
    configWatcher = undefined;
  }

  function startWatching(ctx: ExtensionContext): void {
    stopWatching();
    const configPath = resolveSmallModelConfigPath();
    const configDirectory = dirname(configPath);
    mkdirSync(configDirectory, { recursive: true });
    configWatcher = watch(configDirectory, (_event, filename) => {
      if (filename && filename.toString() !== basename(configPath)) return;
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        watcherDebounce = undefined;
        void updateStatus(ctx);
      }, 25);
    });
  }

  pi.registerCommand("smallmodel", {
    description: "Select the global model used by lightweight extension tasks",
    handler: async (args, ctx) => {
      if (process.env[SMALL_MODEL_ENV_VAR]?.trim()) {
        ctx.ui.notify(
          `${SMALL_MODEL_ENV_VAR} is overriding the global config. Unset it before using /smallmodel.`,
          "warning",
        );
        await updateStatus(ctx);
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "status") {
        try {
          const loaded = loadSmallModelConfig();
          ctx.ui.notify(
            `Global small model is ${loaded.config.provider}/${loaded.config.model} (${loaded.config.thinkingLevel}, ${loaded.source}).`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const config = trimmed ? parseCommandConfig(trimmed) : await selectModel(ctx);
      if (!config) {
        if (trimmed) {
          ctx.ui.notify(
            "Usage: /smallmodel [provider/model-id [off|minimal|low|medium|high|xhigh|max] | status]",
            "warning",
          );
        }
        return;
      }
      await applyConfig(config, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await updateStatus(ctx);
    startWatching(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopWatching();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
