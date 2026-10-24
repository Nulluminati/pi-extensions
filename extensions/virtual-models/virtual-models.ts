/** Opt-in virtual-model routers. Never changes saved selections. */
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractProviderUsage, installClassifierMeasurement } from "./src/measurement.ts";
import {
  createFamilyRouter,
  createWorkerRouter,
  recoverVirtualModelRequest,
} from "./src/router.ts";
import { FAMILY_FALLBACKS } from "./src/worker-catalog.ts";
import { WORKER_POLICY_VERSION } from "./src/worker-policy.ts";

// --- Extension ---

export default async function (pi: ExtensionAPI) {
  const role = process.env.PI_WORKER === "1" ? "worker" : "main";
  const trace = process.env.PI_VIRTUAL_MODEL_TRACE;
  let sequence = 0;
  const measuredRegistries = new WeakSet<object>();
  async function record(
    type: "route" | "loadout" | "classifier_start" | "classifier_end" | "provider_usage",
    entry: object,
  ) {
    const decision = { routeId: `${process.pid}/${++sequence}`, ...entry };
    pi.appendEntry(`virtual-models-${type}`, decision);
    if (trace)
      await appendFile(
        `${trace}.${process.pid}.jsonl`,
        `${JSON.stringify({ type, pid: process.pid, at: new Date().toISOString(), ...decision })}\n`,
        { mode: 0o600 },
      );
    return decision.routeId;
  }
  pi.on("provider_stream_event", async (event) => {
    if (!trace) return;
    const usage = extractProviderUsage(event.data);
    if (usage)
      await record("provider_usage", {
        role,
        provider: event.provider,
        api: event.api,
        model: event.model,
        usage,
      });
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!trace && ctx.model?.provider !== "virtual-models") return;
    if (trace)
      installClassifierMeasurement(ctx.modelRegistry, measuredRegistries, (type, entry) =>
        record(type, { role, ...entry }),
      );
    await record("loadout", {
      role,
      selected: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      selectedThinking: pi.getThinkingLevel(),
      activeTools: [...pi.getActiveTools()].sort(),
      tools: pi
        .getAllTools()
        .map((tool) => ({ name: tool.name, exposure: tool.exposure ?? "direct" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });
  for (const policy of FAMILY_FALLBACKS) {
    pi.registerVirtualModel({
      provider: "virtual-models",
      id: policy.id,
      name: policy.name,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 500000,
      maxTokens: 128000,
      input: ["text"],
      route: createFamilyRouter(policy.family, role, async (entry) => {
        await record("route", entry);
      }),
    });
  }
  pi.on("agent_before_settle", (event, ctx) => recoverVirtualModelRequest(event, ctx, role));
  pi.registerVirtualModel({
    provider: "virtual-models",
    id: WORKER_POLICY_VERSION,
    name: "Jev worker selection and recovery v1",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 500000,
    maxTokens: 128000,
    input: ["text"],
    route: createWorkerRouter(role, async (entry) => {
      await record("route", entry);
    }),
  });
}
