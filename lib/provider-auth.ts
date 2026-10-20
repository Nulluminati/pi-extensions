/**
 * Provider credential resolution shared by extensions that wrap a single
 * hosted provider. Resolution order: a key registered on Pi's model registry
 * wins; the provider's environment variable is the fallback.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ProviderKeyOptions {
  /** Provider id as registered in Pi's model registry. */
  provider: string;
  /** Environment variable holding the fallback API key. */
  envVar: string;
}

function getEnvApiKey(envVar: string): string | undefined {
  const val = process.env[envVar];
  return val ? val.trim() || undefined : undefined;
}

export async function resolveProviderApiKey(
  ctx: ExtensionContext,
  options: ProviderKeyOptions,
): Promise<string | undefined> {
  try {
    const authKey = await ctx.modelRegistry.getApiKeyForProvider(options.provider);
    if (authKey) return authKey;
  } catch {
    // Provider not registered yet, ignore.
  }
  return getEnvApiKey(options.envVar);
}

export function createProviderAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}
