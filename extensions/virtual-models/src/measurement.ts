/** Evaluator-only observation of registry classifiers, including approval checks outside the router. */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function extractProviderUsage(data: unknown): Record<string, unknown> | undefined {
  const event = recordValue(data);
  const usage = recordValue(
    event.usage ?? recordValue(event.response).usage ?? recordValue(event.message).usage,
  );
  const result: Record<string, unknown> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
  ]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  for (const key of [
    "input_tokens_details",
    "output_tokens_details",
    "prompt_tokens_details",
    "completion_tokens_details",
  ]) {
    const details = recordValue(usage[key]);
    const fields = Object.fromEntries(
      ["cached_tokens", "reasoning_tokens", "audio_tokens"].flatMap((name) =>
        typeof details[name] === "number" && Number.isFinite(details[name]) && details[name] >= 0
          ? [[name, details[name]]]
          : [],
      ),
    );
    if (Object.keys(fields).length) result[key] = fields;
  }
  return Object.keys(result).length ? result : undefined;
}

export function installClassifierMeasurement(
  registry: ModelRegistry,
  installed: WeakSet<object>,
  record: (type: "classifier_start" | "classifier_end", entry: object) => Promise<string>,
) {
  if (installed.has(registry)) return;
  installed.add(registry);
  const classify = registry.classify.bind(registry);
  registry.classify = async (model, context, options) => {
    const started = performance.now();
    const callId = await record("classifier_start", { provider: model.provider, model: model.id });
    try {
      const result = await classify(model, context, options);
      await record("classifier_end", {
        callId,
        provider: result.provider,
        model: result.model,
        stopReason: result.stopReason,
        usage: result.usage ?? null,
        latencyMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      await record("classifier_end", {
        callId,
        provider: model.provider,
        model: model.id,
        stopReason: "error",
        usage: null,
        latencyMs: performance.now() - started,
      });
      throw error;
    }
  };
}
