/**
 * Neuralwatt Provider Extension
 *
 * Registers Neuralwatt (neuralwatt.com) as a Pi model provider using their
 * OpenAI-compatible API. Ships a hardcoded model catalog so registration is
 * synchronous, and checks it against the live public /v1/models list on
 * session_start so newly published models can be added.
 *
 * Neuralwatt exposes per-model energy usage (kWh) alongside token pricing; the
 * /neuralwatt:quota command surfaces credits, monthly usage, and (when active)
 * subscription energy quota.
 *
 * Auth (choose one):
 *   1. NEURALWATT_API_KEY environment variable
 *   2. $PI_CODING_AGENT_DIR/auth.json (default ~/.pi/agent/auth.json): { "neuralwatt": { "type": "api_key", "key": "..." } }
 *   3. CLI flag: pi --model neuralwatt/glm-5.2 --api-key ...
 */

import type { ExtensionAPI } from "pi";
import { authPath } from "../../lib/paths.ts";
import { formatProviderModelList } from "../../lib/provider-models.ts";
import { getResolvedApiKey } from "./src/auth.ts";
import { fetchCatalog, findMissingModels, MISSING_MODELS_MESSAGE } from "./src/catalog.ts";
import { NEURALWATT_API_BASE_URL, NEURALWATT_CLIENT_HEADERS } from "./src/constants.ts";
import {
  computeFlexState,
  FLEX_EVENT,
  type FlexState,
  fetchFlexCapableIds,
  injectServiceTier,
} from "./src/flex.ts";
import { STATIC_MODELS } from "./src/models.ts";
import { fetchQuota, formatQuotaDisplay } from "./src/quota.ts";

export type { NeuralwattModelsResponse, NeuralwattQuotaResponse } from "./src/types.ts";
export { FLEX_EVENT, type FlexState, MISSING_MODELS_MESSAGE, STATIC_MODELS };

// --- Extension ---

export default async function neuralwattExtension(pi: ExtensionAPI) {
  // Flex state is per-instance (closure-scoped) so it never leaks across Pi
  // instances or tests. `flexToggleOn` is the user's toggle; `flexCapableIds`
  // is the set of Neuralwatt base model ids with a flex sibling, rebuilt from
  // the authenticated catalog on session_start. An empty set (no key or fetch
  // failure) hides the indicator and makes the toggle warn unavailable.
  let flexToggleOn = false;
  let flexCapableIds = new Set<string>();

  function emitFlexState(model: { provider?: string; id: string } | undefined): void {
    const state = computeFlexState(model, flexToggleOn, flexCapableIds);
    pi.events.emit(FLEX_EVENT, state);
  }

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
  // pay a startup fetch; uses the unauthenticated /v1/models view and ignores
  // flex siblings represented by the service-tier toggle. Silent on network
  // error; never blocks.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const apiKey = await getResolvedApiKey(ctx);
    if (!apiKey) return;
    const catalog = await fetchCatalog(ctx.signal);
    const missing = findMissingModels(catalog);
    if (missing.length > 0) {
      ctx.ui.notify(
        `${MISSING_MODELS_MESSAGE}:\n${missing.map((id) => `  • ${id}`).join("\n")}`,
        "warning",
      );
    }

    // Build the flex-capable set from the authenticated catalog. Reuses the key
    // resolved above; silent on fetch error so the indicator and toggle just
    // report flex as unavailable.
    flexCapableIds = await fetchFlexCapableIds(apiKey, ctx.signal);
    emitFlexState(ctx.model);
  });

  // Inject `service_tier: "flex"` on outgoing requests when the toggle is on
  // and the request's model is flex-capable. Returns the modified payload to
  // replace the original; undefined leaves it untouched.
  pi.on("before_provider_request", async (event, _ctx) => {
    return injectServiceTier((event as { payload: unknown }).payload, flexToggleOn, flexCapableIds);
  });

  // Re-publish flex state when the selected model changes so the status bar
  // updates its badge (and hides it for non-Neuralwatt / non-capable models).
  pi.on("model_select", async (event, ctx) => {
    emitFlexState(event.model);
    if (event.model.provider === "neuralwatt") {
      const modelName = event.model.name || event.model.id;
      ctx.ui.notify(`Using Neuralwatt model: ${modelName}`, "info");
    }
  });

  // /neuralwatt:flex: toggle flex for the current Neuralwatt model. Only
  // applies to Neuralwatt models, and only takes effect when the model has a
  // flex tier available.
  pi.registerCommand("neuralwatt:flex", {
    description: "Toggle Neuralwatt flex pricing tier for the current model",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const model = ctx.model;
      // biome-ignore lint/complexity/useOptionalChain: keep this as a guard so model narrows to non-null for the flexCapableIds/notify uses below; the optional-chain alternative would lose narrowing and require a non-null assertion.
      if (!model || model.provider !== "neuralwatt") {
        ctx.ui.notify("Flex only applies to Neuralwatt models.", "error");
        return;
      }
      if (!flexCapableIds.has(model.id)) {
        const available = [...flexCapableIds].sort().join(", ") || "(none loaded yet)";
        ctx.ui.notify(
          `${model.name || model.id} has no flex tier available. Flex-capable: ${available}`,
          "warning",
        );
        return;
      }
      flexToggleOn = !flexToggleOn;
      emitFlexState(model);
      ctx.ui.notify(
        `Flex ${flexToggleOn ? "enabled" : "disabled"} for ${model.name || model.id}`,
        "info",
      );
    },
  });

  // /neuralwatt:models command
  pi.registerCommand("neuralwatt:models", {
    description: "Display all available Neuralwatt models with pricing and capabilities",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const text = formatProviderModelList(STATIC_MODELS);
      ctx.ui.notify(`Neuralwatt models:\n${text}`, "info");
    },
  });

  // /neuralwatt:quota command
  pi.registerCommand("neuralwatt:quota", {
    description: "Display current Neuralwatt API quota usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const apiKey = await getResolvedApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          `Neuralwatt API key not configured. Set NEURALWATT_API_KEY or add to ${authPath()}.`,
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
}
