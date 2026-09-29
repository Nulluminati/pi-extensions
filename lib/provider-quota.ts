/**
 * Quota-fetch skeleton shared by provider extensions: an authenticated JSON
 * GET under a timeout controller, with the caller's abort signal chained
 * through and non-2xx responses turned into thrown errors.
 */

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(endpoint, {
      headers: createProviderAuthHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch quota: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}
