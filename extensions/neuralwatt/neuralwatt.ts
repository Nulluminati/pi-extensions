/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (neuralwatt.com) as a Pi model provider using their
 * OpenAI-compatible API. Ships a hardcoded model catalog so registration is
 * synchronous, and checks it against the live public /v1/models list on
 * session_start so newly published models can be added.
 *
 * Neuralwatt exposes per-model energy usage (kWh) alongside token pricing; the
 * /neuralwatt-quota command surfaces credits, monthly usage, and (when active)
 * subscription energy quota.
 *
 * Auth (choose one):
 *   1. NEURALWATT_API_KEY environment variable
 *   2. ~/.pi/agent/auth.json: { "neuralwatt": { "type": "api_key", "key": "..." } }
 *   3. CLI flag: pi --model neuralwatt/glm-5.2 --api-key ...
 */

import type { ExtensionAPI } from "pi";
import { getResolvedApiKey } from "./src/auth.ts";
import { fetchCatalog, findMissingModels, MISSING_MODELS_MESSAGE } from "./src/catalog.ts";
import { NEURALWATT_API_BASE_URL, NEURALWATT_CLIENT_HEADERS } from "./src/constants.ts";
import { formatModelList, STATIC_MODELS } from "./src/models.ts";
import { fetchQuota, formatQuotaDisplay } from "./src/quota.ts";

export type { NeuralwattModelsResponse, NeuralwattQuotaResponse } from "./src/types.ts";
export { MISSING_MODELS_MESSAGE, STATIC_MODELS };

// --- Default export ---

export default async function neuralwattExtension(pi: ExtensionAPI) {
  // Register the static catalog synchronously. No startup fetch blocks
  // registration, and the list is available even without an API key.
  pi.registerProvider("neuralwatt", {
    baseUrl: NEURALWATT_API_BASE_URL,
    apiKey: "$NEURALWATT_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: NEURALWATT_CLIENT_HEADERS,
    models: STATIC_MODELS,
  });

  // session_start: best-effort staleness check against the public catalog.
  // Warns (once per session) when Neuralwatt publishes models the static list
  // does not include. Gated on a configured key so non-Neuralwatt users do not
  // pay a startup fetch; uses the unauthenticated /v1/models view so hidden /
  // opt-in models never produce false positives. Silent on network error; never
  // blocks.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const apiKey = await getResolvedApiKey(ctx);
    if (!apiKey) return;
    const catalog = await fetchCatalog(ctx.signal);
    const missing = findMissingModels(catalog);
    if (missing.length === 0) return;
    ctx.ui.notify(
      `${MISSING_MODELS_MESSAGE}:\n${missing.map((id) => `  • ${id}`).join("\n")}`,
      "warning",
    );
  });

  // /neuralwatt-models command
  pi.registerCommand("neuralwatt-models", {
    description: "Display all available Neuralwatt models with pricing and capabilities",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const text = formatModelList(STATIC_MODELS);
      ctx.ui.notify(`Neuralwatt models:\n${text}`, "info");
    },
  });

  // /neuralwatt-quota command
  pi.registerCommand("neuralwatt-quota", {
    description: "Display current Neuralwatt API quota usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const apiKey = await getResolvedApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          "Neuralwatt API key not configured. Set NEURALWATT_API_KEY or add to ~/.pi/agent/auth.json.",
          "error",
        );
        return;
      }
      try {
        const quota = await fetchQuota(apiKey, ctx.signal);
        const text = formatQuotaDisplay(quota);
        ctx.ui.notify(`Neuralwatt quota:\n${text}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Error fetching quota: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Notify when a Neuralwatt model is selected
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider === "neuralwatt") {
      const modelName = event.model.name || event.model.id;
      ctx.ui.notify(`Using Neuralwatt model: ${modelName}`, "info");
    }
  });
}
