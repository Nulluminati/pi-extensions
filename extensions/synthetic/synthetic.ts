/**
 * Synthetic Provider Extension
 *
 * Registers Synthetic (synthetic.new) as a Pi model provider using their
 * OpenAI-compatible API. Ships a hardcoded model catalog so registration is
 * synchronous and thinking levels are configured correctly per model.
 *
 * The model list is validated against the live catalog on session_start: if
 * Synthetic exposes models this extension does not know about, the user is
 * notified so the list can be updated. Pricing and capabilities are stable, so
 * there is no runtime refresh of the static list itself.
 *
 * Auth (choose one):
 *   1. SYNTHETIC_API_KEY environment variable
 *   2. $PI_CODING_AGENT_DIR/auth.json (default ~/.pi/agent/auth.json): { "synthetic": { "type": "api_key", "key": "syn_..." } }
 *   3. CLI flag: pi --model synthetic/hf:zai-org/GLM-5.2 --api-key syn_...
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authPath } from "../../lib/paths.ts";
import { formatProviderModelList } from "../../lib/provider-models.ts";
import { getResolvedApiKey } from "./src/auth.ts";
import { fetchCatalog, findMissingModels, MISSING_MODELS_MESSAGE } from "./src/catalog.ts";
import { SYNTHETIC_API_BASE_URL } from "./src/constants.ts";
import { STATIC_MODELS } from "./src/models.ts";
import { fetchQuota, formatQuotaDisplay } from "./src/quota.ts";

// --- Extension ---

export default async function syntheticExtension(pi: ExtensionAPI) {
  // Register the static catalog synchronously. No startup fetch blocks
  // registration, and the list is available even without an API key.
  pi.registerProvider("synthetic", {
    baseUrl: SYNTHETIC_API_BASE_URL,
    apiKey: "$SYNTHETIC_API_KEY",
    api: "openai-completions",
    models: STATIC_MODELS,
  });

  // session_start: best-effort staleness check. Warns (once per session) when
  // the live catalog exposes always-on, tools-capable models the static list
  // does not include. Silent on missing key; a catalog fetch failure logs a
  // debug diagnostic and skips the check without a UI warning.
  async function checkCatalog(
    apiKey: string,
    signal: AbortSignal | undefined,
    notify: (message: string) => void,
  ) {
    const catalog = await fetchCatalog(apiKey, signal);
    if (catalog === undefined) return;
    const missing = findMissingModels(catalog);
    if (missing.length === 0) return;
    notify(`${MISSING_MODELS_MESSAGE}:\n${missing.map((id) => `  • ${id}`).join("\n")}`);
  }

  // Pi awaits session_start before the editor accepts input, so the handler
  // only resolves the key and returns. The catalog check runs in the
  // background and the warning arrives when the fetch settles, at worst one
  // fetch timeout after startup. If Pi replaces the session or reloads before
  // then, the captured ctx is stale and throws; the result is dropped.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const apiKey = await getResolvedApiKey(ctx);
    if (!apiKey) return;
    const notify = (message: string) => ctx.ui.notify(message, "warning");
    void checkCatalog(apiKey, ctx.signal, notify).catch(() => {});
  });

  // /synthetic:models command
  pi.registerCommand("synthetic:models", {
    description: "Display all available Synthetic models with pricing and capabilities",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const text = formatProviderModelList(STATIC_MODELS);
      ctx.ui.notify(`Synthetic models:\n${text}`, "info");
    },
  });

  // /synthetic:quota command
  pi.registerCommand("synthetic:quota", {
    description: "Display current Synthetic API quota usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const apiKey = await getResolvedApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          `Synthetic API key not configured. Set SYNTHETIC_API_KEY or add to ${authPath()}.`,
          "error",
        );
        return;
      }
      try {
        const quota = await fetchQuota(apiKey, ctx.signal);
        const text = formatQuotaDisplay(quota);
        ctx.ui.notify(`Synthetic quota:\n${text}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Error fetching quota: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Notify when a Synthetic model is selected
  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider === "synthetic") {
      const modelName = event.model.name || event.model.id;
      ctx.ui.notify(`Using Synthetic model: ${modelName}`, "info");
    }
  });
}
