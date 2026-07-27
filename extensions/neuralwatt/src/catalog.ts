import {
  FETCH_TIMEOUT_MS,
  NEURALWATT_CLIENT_HEADERS,
  NEURALWATT_MODELS_ENDPOINT,
} from "./constants.ts";
import { STATIC_MODELS } from "./models.ts";
import type { NeuralwattCatalogModel, NeuralwattModelsResponse } from "./types.ts";

/** Prefix used for the missing-models notice so callers/tests can match it. */
export const MISSING_MODELS_MESSAGE =
  "New Neuralwatt models available that are not in the static list";

/**
 * Fetch the public model catalog from the unauthenticated /v1/models view.
 * Neuralwatt's public list is reachable without a key, so this runs even before
 * credentials are configured. The authenticated view additionally returns
 * hidden/opt-in models, which we do not want to surface here, so no
 * Authorization header is sent. Returns an empty array on any error so the
 * caller stays silent.
 */
export async function fetchCatalog(signal?: AbortSignal): Promise<NeuralwattCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(NEURALWATT_MODELS_ENDPOINT, {
      headers: { Accept: "application/json", ...NEURALWATT_CLIENT_HEADERS },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as NeuralwattModelsResponse;
    return data.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compare the live public catalog against the static list and return any
 * non-deprecated, priced model ids the static list does not include. Hidden /
 * opt-in models are not exposed by the unauthenticated view, so they do not
 * trigger false positives here.
 */
export function findMissingModels(catalog: NeuralwattCatalogModel[]): string[] {
  const known = new Set(STATIC_MODELS.map((m) => m.id));
  const missing: string[] = [];
  for (const m of catalog) {
    if (m.metadata?.deprecated) continue;
    if (m.metadata?.pricing?.pricing_tbd) continue;
    if (!known.has(m.id)) missing.push(m.id);
  }
  return missing;
}
