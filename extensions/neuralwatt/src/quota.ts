import { fetchProviderQuota } from "../../../lib/provider-quota.ts";
import { FETCH_TIMEOUT_MS, NEURALWATT_QUOTA_ENDPOINT } from "./constants.ts";
import type { NeuralwattQuotaResponse } from "./types.ts";

export async function fetchQuota(
  apiKey: string,
  signal?: AbortSignal,
): Promise<NeuralwattQuotaResponse> {
  return fetchProviderQuota<NeuralwattQuotaResponse>({
    endpoint: NEURALWATT_QUOTA_ENDPOINT,
    apiKey,
    timeoutMs: FETCH_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

function formatEnergy(kwh: number | undefined | null): string {
  if (kwh === undefined || kwh === null) return "—";
  return `${kwh.toFixed(4)} kWh`;
}

export function formatQuotaDisplay(quota: NeuralwattQuotaResponse): string {
  const lines: string[] = [];

  if (quota.balance && typeof quota.balance.total_credits_usd === "number") {
    const remaining = quota.balance.credits_remaining_usd ?? 0;
    const total = quota.balance.total_credits_usd;
    const pct = total > 0 ? (((total - remaining) / total) * 100).toFixed(1) : "0";
    lines.push(
      `Credits: $${remaining.toFixed(2)} remaining of $${total.toFixed(2)} (${pct}% used)`,
    );
    if (quota.balance.accounting_method) {
      lines.push(`Accounting: ${quota.balance.accounting_method}`);
    }
  }

  if (quota.usage?.current_month) {
    const u = quota.usage.current_month;
    const parts: string[] = [];
    if (typeof u.cost_usd === "number") parts.push(`$${u.cost_usd.toFixed(2)}`);
    if (typeof u.requests === "number") parts.push(`${u.requests} requests`);
    if (typeof u.tokens === "number") parts.push(`${u.tokens.toLocaleString()} tokens`);
    if (parts.length > 0) lines.push(`This month: ${parts.join(" · ")}`);
    if (typeof u.energy_kwh === "number") lines.push(`Energy: ${formatEnergy(u.energy_kwh)}`);
  }

  if (quota.subscription) {
    const s = quota.subscription;
    const parts: string[] = [];
    if (s.plan) parts.push(s.plan);
    if (s.status) parts.push(s.status);
    if (typeof s.kwh_included === "number")
      parts.push(`${s.kwh_used ?? 0}/${s.kwh_included} kWh used`);
    if (s.in_overage) parts.push("in overage");
    if (parts.length > 0) lines.push(`Subscription: ${parts.join(" · ")}`);
    if (s.current_period_end) lines.push(`Period ends: ${s.current_period_end}`);
  }

  if (quota.key?.allowance) {
    const a = quota.key.allowance;
    const parts: string[] = [];
    if (typeof a.spent_usd === "number" && typeof a.limit_usd === "number") {
      parts.push(`$${a.spent_usd.toFixed(2)}/$${a.limit_usd.toFixed(2)} spent`);
    }
    if (a.period) parts.push(a.period);
    if (typeof a.remaining_usd === "number") parts.push(`$${a.remaining_usd.toFixed(2)} left`);
    if (a.blocked) parts.push("BLOCKED");
    lines.push(`Key allowance: ${parts.join(" · ")}`);
  }

  if (quota.limits) {
    const l = quota.limits;
    const parts: string[] = [];
    if (l.rate_limit_tier) parts.push(`tier ${l.rate_limit_tier}`);
    if (typeof l.overage_limit_usd === "number")
      parts.push(`overage $${l.overage_limit_usd.toFixed(2)}`);
    if (parts.length > 0) lines.push(`Limits: ${parts.join(" · ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No quota information available.";
}
