/**
 * Quota-fetch skeleton shared by provider extensions: an authenticated JSON
 * GET under a timeout controller, with the caller's abort signal chained
 * through and non-2xx responses turned into thrown errors.
 */

import { createTimeoutController } from "./fetch-timeout.ts";
import { createProviderAuthHeaders } from "./provider-auth.ts";

export interface ProviderQuotaFetchOptions {
  /** Absolute URL of the provider's quota endpoint. */
  endpoint: string;
  /** Resolved API key sent as a Bearer credential. */
  apiKey: string;
  /** Milliseconds before the request aborts itself. */
  timeoutMs: number;
  /** Caller signal; aborting it also aborts the request. */
  signal?: AbortSignal;
}

export async function fetchProviderQuota<T>(options: ProviderQuotaFetchOptions): Promise<T> {
  const { endpoint, apiKey, timeoutMs, signal } = options;
  const { signal: timeoutSignal, cleanup } = createTimeoutController({ timeoutMs, signal });
  try {
    const response = await fetch(endpoint, {
      headers: createProviderAuthHeaders(apiKey),
      signal: timeoutSignal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch quota: ${response.status} ${response.statusText}`);
    }
    // Await the body here so `finally` cleanup runs only after it settles;
    // the timeout and caller signal must stay armed while the body streams.
    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}
