import type { ExtensionContext } from "pi";

// --- Utilities ---

function getApiKey(): string | undefined {
  const val = process.env.SYNTHETIC_API_KEY;
  return val ? val.trim() || undefined : undefined;
}

export async function getResolvedApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const authKey = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
    if (authKey) return authKey;
  } catch {
    // Provider not registered yet, ignore.
  }
  return getApiKey();
}

export function createAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}
