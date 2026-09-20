/**
 * Worker Model Extension
 *
 * Selects one global model and thinking level for delegated worker sessions.
 * The agents extension resolves every `delegate` call through
 * lib/worker-model.ts: this config (or the PI_WORKER_MODEL environment
 * variables) is the source of truth; there is no hardcoded worker model.
 * The status-bar extension renders the selection next to the small model on
 * the editor meta line.
 */

import type { ExtensionAPI, ThinkingLevel } from "pi";
import {
  isWorkerThinkingLevel,
  loadWorkerModelConfig,
  WORKER_MODEL_ENV_VAR,
} from "../../lib/worker-model.ts";
import { applyWorkerConfig, applyWorkerThinkingLevel, parseWorkerModelSpec } from "./src/config.ts";
import { selectWorkerModel } from "./src/picker.ts";

// --- Extension ---

export default async function workerModelExtension(pi: ExtensionAPI) {
  pi.registerCommand("worker-model", {
    description: "Select the global model used by delegated worker sessions",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
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
            `Global worker model is ${loaded.config.provider}/${loaded.config.model} (${loaded.config.thinkingLevel}, ${loaded.source}).`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens[0] === "thinking") {
        const requestedLevel = tokens[1];
        if (tokens.length !== 2 || !requestedLevel || !isWorkerThinkingLevel(requestedLevel)) {
          ctx.ui.notify(
            "Usage: /worker-model thinking <off|minimal|low|medium|high|xhigh|max>",
            "warning",
          );
          return;
        }
        applyWorkerThinkingLevel(requestedLevel as ThinkingLevel, ctx);
        return;
      }

      const config = trimmed ? parseWorkerModelSpec(trimmed) : await selectWorkerModel(ctx);
      if (!config) {
        if (trimmed) {
          ctx.ui.notify(
            "Usage: /worker-model [provider/model-id [level] | thinking <level> | status] — pick from the modal when run without arguments.",
            "warning",
          );
        }
        return;
      }
      applyWorkerConfig(config, ctx);
    },
  });
}
