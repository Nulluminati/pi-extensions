import { fetchProviderQuota } from "../../../lib/provider-quota.ts";
import { FETCH_TIMEOUT_MS, SYNTHETIC_QUOTAS_ENDPOINT } from "./constants.ts";
import type { SyntheticQuotaResponse } from "./types.ts";

export async function fetchQuota(
  apiKey: string,
  signal?: AbortSignal,
): Promise<SyntheticQuotaResponse> {
  return fetchProviderQuota<SyntheticQuotaResponse>({
    endpoint: SYNTHETIC_QUOTAS_ENDPOINT,
    apiKey,
    timeoutMs: FETCH_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

export function formatQuotaDisplay(quota: SyntheticQuotaResponse): string {
  const lines: string[] = [];

  if (quota.subscription && (quota.subscription.limit > 0 || quota.subscription.requests > 0)) {
    const pct =
      quota.subscription.limit > 0
        ? ((quota.subscription.requests / quota.subscription.limit) * 100).toFixed(1)
        : "0";
    lines.push(
      `Subscription: ${quota.subscription.requests}/${quota.subscription.limit} requests (${pct}% used)`,
    );
  }

  if (quota.rollingFiveHourLimit) {
    const r = quota.rollingFiveHourLimit;
    const status = r.limited ? "LIMITED" : "available";
    lines.push(`Rolling 5h: ${r.remaining}/${r.max} remaining (${status})`);
  }

  if (quota.weeklyTokenLimit) {
    const w = quota.weeklyTokenLimit;
    lines.push(`Weekly tokens: ${w.percentRemaining.toFixed(1)}% remaining`);
  }

  if (quota.search?.hourly && (quota.search.hourly.limit > 0 || quota.search.hourly.requests > 0)) {
    lines.push(
      `Search hourly: ${quota.search.hourly.requests}/${quota.search.hourly.limit} requests`,
    );
  }

  if (quota.freeToolCalls && (quota.freeToolCalls.limit > 0 || quota.freeToolCalls.requests > 0)) {
    lines.push(
      `Free tool calls: ${quota.freeToolCalls.requests}/${quota.freeToolCalls.limit} requests`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "No quota information available.";
}
