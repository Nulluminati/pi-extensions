import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { extractText } from "../../../lib/session-utils.ts";
import { MODEL_POOL, ruleChoice, subscriptionExhausted } from "./policy.ts";

export const WORKER_POLICY_VERSION = "worker-auto-v1";
const MAX_CONSECUTIVE_FAILURES = 2;
const APPROVED_MODELS = new Set<string>(Object.values(MODEL_POOL));
export type WorkerFailureKind = "quota" | "transient";
interface AssistantEntry {
  id: string;
  message: AssistantMessage;
  modelSpec: string;
}
export interface WorkerHistory {
  prompt: string;
  latest?: AssistantEntry;
  blockedProviders: Set<string>;
  blockedModels: Set<string>;
  failures: Map<string, number>;
}

export function workerFailure(message: AssistantMessage): WorkerFailureKind | undefined {
  if (message.stopReason !== "error" || isContextOverflow(message)) return undefined;
  const error = message.errorMessage ?? "";
  if (
    /GoUsageLimitError|FreeUsageLimitError|insufficient_quota|subscription_sharing_usage_limit_exceeded/i.test(
      error,
    )
  )
    return "quota";
  // Access denial outranks generic quota wording; explicit provider quota codes remain authoritative.
  if (
    /^\s*401\b|\b(?:http|status(?: code)?)\s*[:=]?\s*401\b|unauthori[sz]ed|forbidden|permission denied|invalid.{0,20}(?:api.?key|credentials?)/i.test(
      error,
    )
  )
    return undefined;
  if (subscriptionExhausted(error) || /out of budget/i.test(error)) return "quota";
  if (/^\s*403\b|\b(?:http|status(?: code)?)\s*[:=]?\s*403\b/i.test(error)) return undefined;
  return isRetryableAssistantError(message) ? "transient" : undefined;
}

export function workerOrder(prompt: string): string[] {
  const choice = ruleChoice(prompt);
  if (choice === "sol") return [MODEL_POOL.sol, MODEL_POOL.deepseek, MODEL_POOL.glm];
  if (choice === "deepseek") return [MODEL_POOL.deepseek, MODEL_POOL.glm, MODEL_POOL.sol];
  return [MODEL_POOL.glm, MODEL_POOL.deepseek, MODEL_POOL.sol];
}

/** Raw branch entries retain failed attempts even when Pi omits them from provider context. */
export function workerHistory(entries: readonly unknown[]): WorkerHistory {
  const history: WorkerHistory = {
    prompt: "",
    blockedProviders: new Set(),
    blockedModels: new Set(),
    failures: new Map(),
  };
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as {
      type?: unknown;
      id?: unknown;
      message?: Partial<Omit<AssistantMessage, "role" | "content">> & {
        role?: string;
        content?: unknown;
      };
    };
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message;
    if (message.role === "user") history.prompt = extractText(message.content).slice(0, 12000);
    if (message.role !== "assistant") continue;
    // An unsupported latest assistant must not expose an older physical failure as recoverable.
    delete history.latest;
    if (
      typeof entry.id !== "string" ||
      typeof message.provider !== "string" ||
      typeof message.model !== "string" ||
      typeof message.stopReason !== "string"
    )
      continue;
    const modelSpec = `${message.provider}/${message.model}`;
    const assistant = message as AssistantMessage;
    history.latest = { id: entry.id, message: assistant, modelSpec };
    if (!APPROVED_MODELS.has(modelSpec)) continue;
    const kind = workerFailure(assistant);
    if (kind === "quota") history.blockedProviders.add(message.provider);
    if (kind === "transient") {
      const failures = (history.failures.get(modelSpec) ?? 0) + 1;
      history.failures.set(modelSpec, failures);
      if (failures >= MAX_CONSECUTIVE_FAILURES) history.blockedModels.add(modelSpec);
    } else {
      history.failures.delete(modelSpec);
      if (
        message.stopReason === "stop" ||
        message.stopReason === "toolUse" ||
        message.stopReason === "length"
      ) {
        history.blockedProviders.delete(message.provider);
        history.blockedModels.delete(modelSpec);
      }
    }
  }
  return history;
}

export function approvedWorkerModel(modelSpec: string): boolean {
  return APPROVED_MODELS.has(modelSpec);
}
