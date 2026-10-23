import type { ThinkingLevel } from "pi";
import type { WorkerRecord } from "./types.ts";

export type WorkerPhysicalModel = Pick<WorkerRecord, "physicalModel" | "physicalThinkingLevel">;
const LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function physicalSpec(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._:/+@-]+$/.test(value)
  )
    return undefined;
  if (value.startsWith("virtual-models/")) return undefined;
  return value;
}

/** Display metadata never grants authority or changes the configured worker model. */
export function updateWorkerPhysicalModel(event: unknown, target: WorkerPhysicalModel): void {
  if (!object(event)) return;
  let modelSpec: string | undefined;
  let thinking: unknown;
  if (
    event.type === "entry_appended" &&
    object(event.entry) &&
    event.entry.type === "custom" &&
    event.entry.customType === "virtual-models-route" &&
    object(event.entry.data)
  ) {
    const data = event.entry.data;
    if (data.role !== "worker" || data.status !== "routed") return;
    modelSpec = physicalSpec(data.dispatched);
    thinking = data.effectiveThinking;
  } else if (
    typeof event.type === "string" &&
    ["message_start", "message_update", "message_end"].includes(event.type) &&
    object(event.message)
  ) {
    const message = event.message;
    if (
      message.role !== "assistant" ||
      typeof message.api !== "string" ||
      message.api === "pi-virtual" ||
      typeof message.provider !== "string" ||
      typeof message.model !== "string"
    )
      return;
    modelSpec = physicalSpec(`${message.provider}/${message.model}`);
    thinking = message.thinkingLevel;
  }
  if (!modelSpec) return;
  if (target.physicalModel !== modelSpec) delete target.physicalThinkingLevel;
  target.physicalModel = modelSpec;
  if (typeof thinking === "string" && LEVELS.has(thinking as ThinkingLevel))
    target.physicalThinkingLevel = thinking as ThinkingLevel;
}

export function physicalWorkerLabel(modelSpec: string | undefined): string | undefined {
  const valid = physicalSpec(modelSpec);
  if (!valid) return undefined;
  const slash = valid.indexOf("/");
  const provider = valid.slice(0, slash);
  const id = valid.slice(slash + 1);
  const name = id.startsWith("hf:") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return `${name} (${provider})`;
}
