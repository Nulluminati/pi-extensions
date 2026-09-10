/**
 * Worker Model Extension
 *
 * Selects one global model for delegated worker sessions. The agents
 * extension resolves the model for every `delegate` call through
 * lib/worker-model.ts: this config (or the PI_WORKER_MODEL environment
 * variable) is the source of truth — there is no hardcoded worker model
 * anywhere. The status-bar extension renders the selection next to the
 * small model on the editor meta line.
 */

import type { ExtensionAPI } from "pi";
import { loadWorkerModelConfig, WORKER_MODEL_ENV_VAR } from "../../lib/worker-model.ts";
import { applyWorkerConfig } from "./src/config.ts";
import { selectWorkerModel } from "./src/picker.ts";

// --- Extension ---

export default async function workerModelExtension(pi: ExtensionAPI) {
  pi.registerCommand("worker-model", {
    description: "Select the global model used by delegated worker sessions",
    handler: async (args, ctx) => {
      if (process.env[WORKER_MODEL_ENV_VAR]?.trim()) {
        ctx.ui.notify(
          `${WORKER_MODEL_ENV_VAR} is overriding the global config. Unset it before using /worker-model.`,
          "warning",
        );
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
      applyWorkerConfig(config, ctx);
    },
  });
}

function parseArgs(args: string): { provider: string; model: string } | undefined {
  const [provider, ...rest] = args.split("/");
  if (!provider?.trim() || rest.length === 0 || rest.some((part) => !part.trim())) {
    return undefined;
  }
  return { provider: provider.trim(), model: rest.join("/").trim() };
}
