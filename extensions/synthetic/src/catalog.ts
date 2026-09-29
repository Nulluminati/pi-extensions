import { createTimeoutController } from "../../../lib/fetch-timeout.ts";
import { createAuthHeaders } from "./auth.ts";
import { FETCH_TIMEOUT_MS, SYNTHETIC_MODELS_ENDPOINT } from "./constants.ts";
import { STATIC_MODELS } from "./models.ts";
import type { SyntheticCatalogModel, SyntheticModelsResponse } from "./types.ts";

/** Prefix used for the missing-models notice so callers/tests can match it. */
export const MISSING_MODELS_MESSAGE =
  "New Synthetic models available that are not in the static list";

/**
 * Fetch the live catalog (id + always_on + supported_features only) for the
 * startup staleness check. Returns the model list on success (an empty array
 * for a valid response without entries) and undefined on transport error or a
 * non-OK response, so the caller can tell a failure apart from an in-sync
 * catalog. Failures log a debug diagnostic with the provider and error/status;
 * they never raise a UI warning.
 */
export async function fetchCatalog(
  apiKey: string,
  signal?: AbortSignal,
): Promise<SyntheticCatalogModel[] | undefined> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController({
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  try {
    const response = await fetch(SYNTHETIC_MODELS_ENDPOINT, {
      headers: createAuthHeaders(apiKey),
      signal: timeoutSignal,
    });
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      console.debug(`[synthetic] model catalog check failed: HTTP ${response.status}${statusText}`);
      return undefined;
    }
    const data = (await response.json()) as SyntheticModelsResponse;
    return data.data ?? [];
  } catch (error) {
    console.debug(
      `[synthetic] model catalog check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  } finally {
    cleanup();
  }
}

/**
 * Compare the live catalog against the static list and return any always-on,
 * tools-capable model ids the static list does not include. This is the only
 * signal we surface to the user — pricing and capability drift are ignored on
 * purpose (they have not changed historically).
 */
export function findMissingModels(catalog: SyntheticCatalogModel[]): string[] {
  const known = new Set(STATIC_MODELS.map((m) => m.id));
  const missing: string[] = [];
  for (const m of catalog) {
    if (!m.always_on) continue;
    if (m.supported_features && !m.supported_features.includes("tools")) continue;
    if (!known.has(m.id)) missing.push(m.id);
  }
  return missing;
}
