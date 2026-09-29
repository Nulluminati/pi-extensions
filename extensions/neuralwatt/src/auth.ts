import type { ExtensionContext } from "pi";
import { createProviderAuthHeaders, resolveProviderApiKey } from "../../../lib/provider-auth.ts";

// --- Utilities ---

export async function getResolvedApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  return resolveProviderApiKey(ctx, { provider: "neuralwatt", envVar: "NEURALWATT_API_KEY" });
}

export function createAuthHeaders(apiKey: string): Record<string, string> {
  return createProviderAuthHeaders(apiKey);
}
