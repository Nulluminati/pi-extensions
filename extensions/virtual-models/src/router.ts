import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionContext,
  Model,
  ModelRoute,
  ModelRouteRequest,
} from "pi";
import { extractText } from "../../../lib/session-utils.ts";
import type { RouteRecord } from "./types.ts";
import { FAMILY_FALLBACKS, WORKER_TARGETS, workerFamily } from "./worker-catalog.ts";
import { classifyWorkerModel } from "./worker-classifier.ts";
import {
  approvedWorkerModel,
  WORKER_POLICY_VERSION,
  type WorkerHistory,
  workerFailure,
  workerHistory,
  workerOrder,
} from "./worker-policy.ts";

interface RoutingPolicy {
  id: string;
  family?: "glm" | "deepseek";
}

function spec(model: Model): string {
  return `${model.provider}/${model.id}`;
}
function routingPolicy(id: string): RoutingPolicy | undefined {
  return id === WORKER_POLICY_VERSION
    ? { id }
    : FAMILY_FALLBACKS.find((policy) => policy.id === id);
}
function eligibleModels(
  ctx: ExtensionContext,
  history: WorkerHistory,
  family?: RoutingPolicy["family"],
): Map<string, Model> {
  const available = new Map<string, Model>();
  for (const model of ctx.modelRegistry.getAvailable()) {
    if (typeof model.provider !== "string") continue;
    const modelSpec = spec(model);
    if (
      model.api !== "pi-virtual" &&
      approvedWorkerModel(modelSpec) &&
      (!family || workerFamily(modelSpec) === family) &&
      !history.blockedProviders.has(model.provider) &&
      !history.blockedModels.has(modelSpec)
    )
      available.set(modelSpec, model);
  }
  return available;
}
function familyCandidates(available: Map<string, Model>): Map<string, Model> {
  const families = new Map<string, Model>();
  for (const targets of Object.values(WORKER_TARGETS)) {
    const target = targets.find((modelSpec) => available.has(modelSpec));
    const model = target ? available.get(target) : undefined;
    if (target && model) families.set(target, model);
  }
  return families;
}
function restoredModel(state: unknown, policyId: string): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = state as { policyVersion?: unknown; modelSpec?: unknown };
  return value.policyVersion === policyId && typeof value.modelSpec === "string"
    ? value.modelSpec
    : undefined;
}

export function createWorkerRouter(
  role: "main" | "worker",
  record: (entry: RouteRecord) => Promise<void>,
) {
  return createRouter({ id: WORKER_POLICY_VERSION }, role, record);
}

export function createFamilyRouter(
  family: "glm" | "deepseek",
  role: "main" | "worker",
  record: (entry: RouteRecord) => Promise<void>,
) {
  const policy = FAMILY_FALLBACKS.find((entry) => entry.family === family);
  if (!policy) throw new Error(`Unsupported fallback family: ${family}`);
  return createRouter(policy, role, record);
}

function createRouter(
  policy: RoutingPolicy,
  role: "main" | "worker",
  record: (entry: RouteRecord) => Promise<void>,
) {
  return async (request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> => {
    const started = performance.now();
    const entry: RouteRecord = {
      policyVersion: policy.id,
      role,
      selected: spec(request.model),
      requestReason: request.reason,
      requestedThinking: request.thinkingLevel,
      reason: "assignment",
      status: "routed",
      latencyMs: 0,
    };
    try {
      if (!policy.family && role !== "worker")
        throw new Error("Automatic worker routing requires a worker session");
      if (request.signal?.aborted) throw new Error("Virtual model routing cancelled");
      const history = workerHistory(ctx.sessionManager.getBranch());
      if (request.reason === "retry") {
        if (
          !request.failed ||
          !approvedWorkerModel(spec(request.failed.model)) ||
          (policy.family && workerFamily(spec(request.failed.model)) !== policy.family) ||
          history.latest?.modelSpec !== spec(request.failed.model) ||
          history.latest.message.stopReason !== "error"
        )
          throw new Error("Retry has no recorded failed physical dispatch");
        if (!workerFailure(request.failed.message))
          throw new Error("Virtual model routing does not retry this failure category");
      }
      const user = request.messages.filter((message) => message.role === "user").at(-1);
      const prompt = history.prompt || (user ? extractText(user.content).slice(0, 12000) : "");
      // Raw history identifies the continuing assignment when Pi omits a response and exposes the original user message again.
      const continuingAssignment = history.latest !== undefined;
      const prior =
        !policy.family && request.reason === "user" && !continuingAssignment
          ? undefined
          : request.failed
            ? spec(request.failed.model)
            : (restoredModel(request.state, policy.id) ??
              (request.previous ? spec(request.previous.model) : history.latest?.modelSpec));
      const preferred =
        prior && (!policy.family || workerFamily(prior) === policy.family) ? prior : undefined;
      const available = eligibleModels(ctx, history, policy.family);
      const family = policy.family ?? (preferred ? workerFamily(preferred) : undefined);
      let model = preferred ? available.get(preferred) : undefined;
      if (preferred && family === "sol" && !model)
        throw new Error("GPT-6.1 Sol unavailable: Codex has no fallback; worker stops");
      const nextProvider = family
        ? WORKER_TARGETS[family].find((modelSpec) => available.has(modelSpec))
        : undefined;
      const candidates = familyCandidates(available);
      if (model) entry.reason = "sticky";
      else if (nextProvider) {
        model = available.get(nextProvider);
        entry.reason = preferred ? "provider-fallback" : "provider-choice";
      } else if (candidates.size === 1) {
        model = candidates.values().next().value;
        entry.reason = "only-eligible";
      } else if (!policy.family && candidates.size > 1) {
        const classified = await classifyWorkerModel(
          [...candidates.values()],
          prompt,
          request.reason,
          history,
          ctx,
          request.signal,
        );
        entry.classifier = classified.record;
        model = classified.modelSpec ? candidates.get(classified.modelSpec) : undefined;
        entry.reason = model ? "classifier-choice" : "classifier-fallback";
        if (!model) {
          const fallback = workerOrder(prompt).find((candidate) => candidates.has(candidate));
          model = fallback ? candidates.get(fallback) : undefined;
        }
      }
      if (request.signal?.aborted) throw new Error("Virtual model routing cancelled");
      if (!model)
        throw new Error(
          policy.family
            ? `${policy.family} provider pool exhausted or has no available credentials`
            : "Approved worker model pool exhausted or has no available credentials",
        );
      const modelSpec = spec(model);
      const thinkingLevel = clampThinkingLevel(model, request.thinkingLevel);
      entry.dispatched = modelSpec;
      if (preferred !== undefined) entry.previous = preferred;
      entry.switched = preferred !== undefined && preferred !== modelSpec;
      entry.effectiveThinking = thinkingLevel;
      return { model, thinkingLevel, state: { policyVersion: policy.id, modelSpec } };
    } catch (error) {
      entry.status = "error";
      entry.reason = policy.family ? "provider-routing-stopped" : "worker-routing-stopped";
      throw error;
    } finally {
      entry.latencyMs = Math.max(0, performance.now() - started);
      await record(entry);
    }
  };
}

/** Pi excludes hard quota errors from automatic retry; recover at its final session boundary. */
export function recoverVirtualModelRequest(
  event: AgentBeforeSettleEvent,
  ctx: ExtensionContext,
  role: "main" | "worker",
): BoundaryResult | undefined {
  if (ctx.model?.provider !== "virtual-models" || event.outcome !== "error" || ctx.signal?.aborted)
    return undefined;
  const policy = routingPolicy(ctx.model.id);
  if (!policy || (!policy.family && role !== "worker")) return undefined;
  const history = workerHistory(ctx.sessionManager.getBranch());
  const failed = history.latest;
  if (
    !failed ||
    !approvedWorkerModel(failed.modelSpec) ||
    (policy.family && workerFamily(failed.modelSpec) !== policy.family)
  )
    return undefined;
  const failureKind = workerFailure(failed.message);
  if (!failureKind) return undefined;
  const candidates = eligibleModels(ctx, history, policy.family);
  const retry = candidates.get(failed.modelSpec);
  const family = workerFamily(failed.modelSpec);
  const stopped = family === "sol" && !retry;
  const nextProvider =
    !retry && family && !stopped
      ? WORKER_TARGETS[family].find((modelSpec) => candidates.has(modelSpec))
      : undefined;
  const nextSpec = retry ? spec(retry) : (nextProvider ?? null);
  const audit = {
    type: "custom" as const,
    customType: policy.family
      ? "virtual-models-provider-recovery"
      : "virtual-models-worker-recovery",
    data: {
      policyVersion: policy.id,
      role,
      failureEntryId: failed.id,
      failureKind,
      from: failed.modelSpec,
      to: nextSpec,
      decision: stopped
        ? "stopped"
        : candidates.size === 0
          ? "exhausted"
          : retry
            ? "retry"
            : nextProvider
              ? "provider-fallback"
              : "select",
      ...(stopped ? { reason: "codex-no-fallback" } : {}),
      candidates: [...candidates.keys()].sort(),
      blockedProviders: [...history.blockedProviders].sort(),
      blockedModels: [...history.blockedModels].sort(),
    },
  };
  if (stopped || candidates.size === 0) return { entries: [audit], continue: false };
  // Omit only the failed response. Raw history and completed tool results remain intact.
  return {
    entries: [{ type: "context_edit", targetId: failed.id, replacement: null }, audit],
    continue: true,
  };
}
