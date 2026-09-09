/**
 * Worker Model Extension
 *
 * Selects one global model for delegated worker sessions and publishes the
 * selection in Pi's status area. The agents extension resolves the model for
 * every `delegate` call through lib/worker-model.ts: this config (or the
 * PI_WORKER_MODEL environment variable) is the source of truth — there is no
 * hardcoded worker model anywhere.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "pi";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  WORKER_MODEL_ENV_VAR,
} from "../../lib/worker-model.ts";
import { applyWorkerConfig } from "./src/config.ts";
import { STATUS_ICON, STATUS_KEY } from "./src/constants.ts";
import { selectWorkerModel } from "./src/picker.ts";
import { updateStatus } from "./src/status.ts";

export { STATUS_ICON };

// --- Extension ---

export default async function workerModelExtension(pi: ExtensionAPI) {
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
    const configPath = resolveWorkerModelConfigPath();
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

  pi.registerCommand("worker-model", {
    description: "Select the global model used by delegated worker sessions",
    handler: async (args, ctx) => {
      if (process.env[WORKER_MODEL_ENV_VAR]?.trim()) {
        ctx.ui.notify(
          `${WORKER_MODEL_ENV_VAR} is overriding the global config. Unset it before using /worker-model.`,
          "warning",
        );
        await updateStatus(ctx);
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "status") {
        try {
          const loaded = loadWorkerModelConfig();
          ctx.ui.notify(
            `Global worker model is ${loaded.config.provider}/${loaded.config.model} (${loaded.source}).`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const config = trimmed ? parseArgs(trimmed) : await selectWorkerModel(ctx);
      if (!config) {
        if (trimmed) {
          ctx.ui.notify(
            "Usage: /worker-model [provider/model-id | status] — pick from the modal when run without arguments.",
            "warning",
          );
        }
        return;
      }
      await applyWorkerConfig(config, ctx);
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

  function parseArgs(args: string): { provider: string; model: string } | undefined {
    const [provider, ...rest] = args.split("/");
    if (!provider?.trim() || rest.length === 0 || rest.some((part) => !part.trim())) {
      return undefined;
    }
    return { provider: provider.trim(), model: rest.join("/").trim() };
  }
}
