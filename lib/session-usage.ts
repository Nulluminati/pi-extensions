/**
 * Sum provider-reported usage across a session branch, matching pi's built-in
 * footer accounting (dist/modes/interactive/components/footer.js):
 *
 * - assistant messages carry `message.usage`
 * - toolResult messages carry `message.usage` (codemode image/classifier and
 *   nested tool calls roll their usage into the top-level toolResult)
 * - standalone `type: "usage"` entries (e.g. cache warming)
 * - `type: "compaction"` and `type: "branch_summary"` entries carry `usage`
 *
 * Nested usage is counted once: it arrives already rolled into the top-level
 * toolResult usage, so summing branch entries never double counts. All fields
 * are read tolerantly — numbers or numeric strings, missing or non-finite
 * values count as 0, and `cost` accepts a number or `{ total }`.
 */

export interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractCostTotal(cost: unknown): number {
  if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
  if (typeof cost === "string") {
    const n = Number(cost);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof cost === "object" && cost !== null) {
    return toNumber((cost as { total?: unknown }).total);
  }
  return 0;
}

/** Sum usage across all billing-relevant entries in a session branch. */
export function sumSessionUsage(entries: readonly unknown[]): SessionUsageTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; usage?: unknown; message?: unknown };
    let usage: unknown;
    if (e.type === "usage") {
      usage = e.usage;
    } else if (e.type === "message" && typeof e.message === "object" && e.message !== null) {
      const msg = e.message as { role?: unknown; usage?: unknown };
      if (msg.role === "assistant") {
        usage = msg.usage;
      } else if (msg.role === "toolResult") {
        usage = msg.usage;
      }
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      usage = e.usage;
    }
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      cost?: unknown;
    };
    input += toNumber(u.input);
    output += toNumber(u.output);
    cacheRead += toNumber(u.cacheRead);
    cacheWrite += toNumber(u.cacheWrite);
    cost += extractCostTotal(u.cost);
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost,
  };
}
