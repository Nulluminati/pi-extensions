/** Display-only tokens owned by the Herdr adapter. */

export const METADATA_EVENTS = [
  "missions:state",
  "workers:state",
  "todos:changed",
  "goal:state-change",
  "messenger:state",
] as const;

export type MetadataEvent = (typeof METADATA_EVENTS)[number];
export type MetadataTokens = Record<string, string | null>;

export function emptyTokens(): MetadataTokens {
  return {
    pi_session_name: null,
    pi_mission: null,
    pi_mission_status: null,
    pi_workers: null,
    pi_worker_cost: null,
    pi_worker_tokens: null,
    pi_cost: null,
    pi_context: null,
    pi_todos: null,
    pi_goal: null,
    pi_messenger: null,
    pi_unread: null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = [...value.replace(/\s+/g, " ")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? [...normalized].slice(0, 80).join("") : null;
}

export function sessionNameToken(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return text(name.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, ""));
}

/** Matches the Claude sidebar row: "ctx 19%". Unknown usage (such as right after compaction) clears it. */
export function contextToken(usage: { percent: number | null } | undefined): string | null {
  const percent = usage?.percent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? `ctx ${Math.round(percent)}%`
    : null;
}

export function readWorkerCost(data: unknown): number | undefined {
  if (!record(data)) return undefined;
  const cost = data.workerCostUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export function eventTokens(event: MetadataEvent, data: unknown): MetadataTokens | undefined {
  if (!record(data)) return undefined;
  switch (event) {
    case "missions:state":
      if (typeof data.active !== "boolean") return undefined;
      return {
        pi_mission: data.active ? text(data.title) : null,
        pi_mission_status: data.active ? text(data.status) : null,
      };
    case "workers:state": {
      if (!count(data.running)) return undefined;
      const cost = readWorkerCost(data);
      return {
        pi_workers: `Workers: ${data.running}`,
        pi_worker_cost: cost !== undefined ? `$${cost.toFixed(4)}` : null,
        pi_worker_tokens: count(data.workerTokens) ? String(data.workerTokens) : null,
      };
    }
    case "todos:changed": {
      if (!Array.isArray(data.items)) return undefined;
      if (!data.items.every((item) => record(item) && typeof item.completed === "boolean"))
        return undefined;
      const completed = data.items.filter((item) => item.completed).length;
      return { pi_todos: `${completed}/${data.items.length}` };
    }
    case "goal:state-change": {
      if (data.status === null) return { pi_goal: null };
      const status = text(data.status);
      if (!status) return undefined;
      const iteration = count(data.iteration) ? ` ${data.iteration}` : "";
      const limit =
        iteration && count(data.maxIterations) && data.maxIterations > 0
          ? `/${data.maxIterations}`
          : "";
      return { pi_goal: text(`${status}${iteration}${limit}`) };
    }
    case "messenger:state":
      if (!count(data.unread) || (data.name !== null && typeof data.name !== "string"))
        return undefined;
      return { pi_messenger: text(data.name), pi_unread: String(data.unread) };
  }
}
