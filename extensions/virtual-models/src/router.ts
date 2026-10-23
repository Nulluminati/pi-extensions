import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ClassifierResult, ExtensionContext, Model, ModelRoute, ModelRouteRequest } from "pi";
import { createTimeoutController } from "../../../lib/fetch-timeout.ts";
import { extractText } from "../../../lib/session-utils.ts";
import { MODEL_POOL, type ModelChoice, POLICY_VERSION, subscriptionExhausted } from "./policy.ts";

interface RoutingState {
  policyVersion: string;
  modelSpec: string;
  role: string;
  turn: number;
}
interface ClassifierRecord {
  attempted: boolean;
  status: string;
  provider: string;
  model: string;
  usage?: ClassifierResult["usage"];
}
export interface RouteRecord {
  policyVersion: string;
  role: "main" | "worker";
  selected: string;
  requestReason: ModelRouteRequest["reason"];
  requestedThinking: string;
  effectiveThinking?: string;
  dispatched?: string;
  previous?: string;
  switched?: boolean;
  reason: string;
  status: "routed" | "paused" | "error";
  latencyMs: number;
  classifier?: ClassifierRecord;
}

function spec(model: Model): string {
  return `${model.provider}/${model.id}`;
}
function physical(ctx: ExtensionContext, modelSpec: string): Model {
  if (!Object.values(MODEL_POOL).some((value) => value === modelSpec))
    throw new Error(`Destination ${modelSpec} is outside the frozen physical pool`);
  const slash = modelSpec.indexOf("/");
  const model = ctx.modelRegistry.find(modelSpec.slice(0, slash), modelSpec.slice(slash + 1));
  if (!model) throw new Error(`Model ${modelSpec} is not in the catalog`);
  if (model.api === "pi-virtual") throw new Error(`Destination ${modelSpec} must be physical`);
  if (
    !ctx.modelRegistry
      .getAvailable()
      .some((entry) => spec(entry) === modelSpec && entry.api !== "pi-virtual")
  )
    throw new Error(`Model ${modelSpec} has no available credentials`);
  return model;
}
function restored(value: unknown): RoutingState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<RoutingState>;
  return state.policyVersion === POLICY_VERSION &&
    typeof state.modelSpec === "string" &&
    typeof state.role === "string" &&
    typeof state.turn === "number"
    ? (state as RoutingState)
    : undefined;
}
function lastUserText(request: ModelRouteRequest): string {
  const message = request.messages.filter((entry) => entry.role === "user").at(-1);
  return message ? extractText(message.content).slice(0, 12000) : "";
}

async function classify(
  request: ModelRouteRequest,
  ctx: ExtensionContext,
  role: string,
): Promise<{ choice: ModelChoice; record: ClassifierRecord }> {
  const record: ClassifierRecord = {
    attempted: false,
    status: "unavailable",
    provider: "typesafe",
    model: "jev-latest",
  };
  const classifier = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
  if (!classifier) return { choice: "sol", record };
  const timeout = createTimeoutController({
    timeoutMs: 10000,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Classifier deadline or cancellation"));
      timeout.signal.addEventListener("abort", onAbort, { once: true });
      if (timeout.signal.aborted) onAbort();
    });
    const available = await Promise.race([
      ctx.modelRegistry.getAvailableOfType("classifier"),
      aborted,
    ]);
    if (!available.some((entry) => entry.provider === "typesafe" && entry.id === "jev-latest"))
      return { choice: "sol", record };
    if (request.signal?.aborted) throw new Error("Routing cancelled");
    record.attempted = true;
    const result = await Promise.race([
      ctx.modelRegistry.classify(
        classifier,
        {
          state: { role, prompt: lastUserText(request) },
          questions: {
            route: {
              type: "choice",
              instructions:
                "Select the physical model for this bounded software task. Prefer the least demanding adequate model. Judge only the supplied request and role.",
              criteria: {
                glm: "Bounded lookup, inventory, or straightforward repository investigation: GLM 5.3 Flash.",
                deepseek:
                  "Ordinary diagnosis, tested fixes, implementation, or mechanical multi-file edits: DeepSeek V4.1 Flash.",
                sol: "Hard reasoning, optimality, safety review, architecture, or ambiguous cross-cutting constraints: GPT 6.1 Sol.",
              },
            },
          },
        },
        { signal: timeout.signal, timeoutMs: 10000, maxRetries: 0 },
      ),
      aborted,
    ]);
    if (result.usage) record.usage = result.usage;
    if (request.signal?.aborted) throw new Error("Routing cancelled");
    const answer = result.answers.route;
    if (result.stopReason !== "stop") {
      record.status = "error";
      return { choice: "sol", record };
    }
    if (
      answer?.type !== "choice" ||
      !Object.hasOwn(MODEL_POOL, answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      record.status = "malformed";
      return { choice: "sol", record };
    }
    const keys = Object.keys(answer.probabilities).sort();
    const probabilities = Object.values(answer.probabilities);
    const selected = answer.probabilities[answer.choice];
    if (
      keys.join() !== "deepseek,glm,sol" ||
      probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.01 ||
      selected === undefined ||
      selected < Math.max(...probabilities)
    ) {
      record.status = "malformed";
      return { choice: "sol", record };
    }
    record.status = "ok";
    return { choice: answer.choice as ModelChoice, record };
  } catch {
    if (request.signal?.aborted) throw new Error("Routing cancelled");
    record.status = timeout.signal.aborted ? "timeout" : "error";
    return { choice: "sol", record };
  } finally {
    if (onAbort) timeout.signal.removeEventListener("abort", onAbort);
    timeout.cleanup();
  }
}

export function createJevRouter(
  role: "main" | "worker",
  record: (value: RouteRecord) => Promise<void>,
) {
  return async (request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> => {
    const started = performance.now();
    const entry: RouteRecord = {
      policyVersion: POLICY_VERSION,
      role,
      selected: spec(request.model),
      requestReason: request.reason,
      requestedThinking: request.thinkingLevel,
      reason: "classifier-choice",
      status: "routed",
      latencyMs: 0,
    };
    try {
      if (request.signal?.aborted) throw new Error("Routing cancelled");
      if (
        request.reason === "retry" &&
        subscriptionExhausted(request.failed?.message.errorMessage ?? "")
      ) {
        entry.status = "paused";
        throw new Error(
          "Experiment paused: chat subscription or quota exhausted; no substitute model dispatched",
        );
      }
      if (request.reason === "retry" && !request.failed) {
        entry.status = "paused";
        throw new Error(
          "Experiment paused: routing failed before physical dispatch; no older model substituted",
        );
      }
      const state = restored(request.state);
      const sticky = request.failed ?? request.previous;
      let destination: string;
      let thinking = request.thinkingLevel;
      let nextState: unknown = request.state;
      if (request.reason === "direct") {
        destination = MODEL_POOL.sol;
        entry.reason = "direct-conservative";
        nextState = undefined;
      } else if (request.reason !== "user" && (sticky || state)) {
        destination = sticky ? spec(sticky.model) : (state?.modelSpec ?? MODEL_POOL.sol);
        thinking = sticky?.thinkingLevel ?? request.thinkingLevel;
        entry.reason = "sticky";
      } else {
        const classified = await classify(request, ctx, role);
        entry.classifier = classified.record;
        entry.reason =
          classified.record.status === "ok" ? "classifier-choice" : "classifier-fallback";
        destination = MODEL_POOL[classified.choice];
        nextState = {
          policyVersion: POLICY_VERSION,
          modelSpec: destination,
          role,
          turn: (state?.turn ?? 0) + 1,
        } satisfies RoutingState;
      }
      if (request.signal?.aborted) throw new Error("Routing cancelled");
      const model = physical(ctx, destination);
      const thinkingLevel = clampThinkingLevel(model, thinking);
      entry.dispatched = destination;
      entry.effectiveThinking = thinkingLevel;
      if (request.previous) entry.previous = spec(request.previous.model);
      entry.switched = entry.previous !== undefined && entry.previous !== destination;
      entry.latencyMs = performance.now() - started;
      await record(entry);
      return { model, thinkingLevel, ...(nextState === undefined ? {} : { state: nextState }) };
    } catch (error) {
      entry.status = entry.status === "paused" ? "paused" : "error";
      entry.latencyMs = performance.now() - started;
      await record(entry);
      throw error;
    }
  };
}
