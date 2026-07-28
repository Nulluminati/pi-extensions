import { createAuthHeaders } from "./auth.ts";
import {
  FETCH_TIMEOUT_MS,
  NEURALWATT_CLIENT_HEADERS,
  NEURALWATT_MODELS_ENDPOINT,
} from "./constants.ts";

/**
 * Inter-extension event emitted on the pi.events bus whenever the flex state for
 * the currently selected model changes. The status-bar extension listens to
 * render a flex badge next to the thinking level. Payload is { flexOn,
 * flexCapable }:
 *   - flexCapable: the current model is a Neuralwatt model with a flex sibling
 *     in the catalog (the badge is shown only when this is true).
 *   - flexOn: flex is active for the current model (toggle on AND capable); the
 *     badge reads "on" or "off" based on this.
 */
export const FLEX_EVENT = "neuralwatt:flex-change";

export interface FlexState {
  flexOn: boolean;
  flexCapable: boolean;
}

/**
 * Fetch the authenticated /v1/models list and return the set of base model ids
 * that have a Flex sibling. Neuralwatt only exposes `<id>-flex` variants to
 * authenticated requests (the public catalog omits them), so this requires a
 * key. Returns an empty set on missing key, transport error, or non-OK
 * response — the caller then surfaces no flex indicator and the toggle warns
 * that no flex-capable models were found.
 */
export async function fetchFlexCapableIds(
  apiKey: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(NEURALWATT_MODELS_ENDPOINT, {
      headers: { ...createAuthHeaders(apiKey), ...NEURALWATT_CLIENT_HEADERS },
      signal: controller.signal,
    });
    if (!response.ok) return new Set();
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    const capable = new Set<string>();
    for (const m of data.data ?? []) {
      // A `-flex` suffix marks a flex sibling; its base id is flex-capable.
      if (typeof m.id === "string" && m.id.endsWith("-flex")) {
        capable.add(m.id.slice(0, -"-flex".length));
      }
    }
    return capable;
  } catch {
    return new Set();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute the flex state to publish for the currently selected model.
 * `flexCapable` is true only for a Neuralwatt model whose id has a flex sibling
 * in `capableIds`. `flexOn` is the effective active state (toggle on AND
 * capable) since flex is meaningless for a non-capable model.
 */
export function computeFlexState(
  model: { provider?: string; id: string } | undefined,
  toggleOn: boolean,
  capableIds: Set<string>,
): FlexState {
  const flexCapable = !!model && model.provider === "neuralwatt" && capableIds.has(model.id);
  return { flexOn: flexCapable && toggleOn, flexCapable };
}

/**
 * Inject `service_tier: "flex"` into an outgoing provider request body when
 * flex is toggled on and the request's model is flex-capable. Returns the
 * modified payload to replace the original, or undefined to leave it unchanged.
 *
 * Uses `service_tier` (not a `-flex` model id) so the model id and prompt cache
 * stay unchanged — Neuralwatt's flex docs recommend this form precisely because
 * flex and standard share a server-side cache. Checking the payload's own model
 * id (rather than ctx.model) keeps the injection robust even if the active
 * model and request model ever diverge.
 */
export function injectServiceTier(
  payload: unknown,
  toggleOn: boolean,
  capableIds: Set<string>,
): Record<string, unknown> | undefined {
  if (!toggleOn) return undefined;
  if (!payload || typeof payload !== "object") return undefined;
  const body = payload as Record<string, unknown>;
  const model = body.model;
  if (typeof model !== "string" || !capableIds.has(model)) return undefined;
  return { ...body, service_tier: "flex" };
}
