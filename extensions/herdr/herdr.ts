/** Publish extension display values without taking over Herdr's agent state. */

import type { ExtensionAPI, ExtensionContext } from "pi";
import { sumSessionUsage } from "../../lib/session-usage.ts";
import { reportMetadata } from "./src/client.ts";
import {
  emptyTokens,
  eventTokens,
  METADATA_EVENTS,
  type MetadataTokens,
  readWorkerCost,
} from "./src/metadata.ts";

// --- Constants ---

const SOURCE = "pi-extensions:herdr";
const TTL_MS = 60_000;
const REFRESH_MS = 20_000;
const DEBOUNCE_MS = 50;

// --- Extension ---

export default async function herdrExtension(pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH ?? "";
  const paneId = process.env.HERDR_PANE_ID ?? "";
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId || process.env.PI_WORKER === "1")
    return;

  let tokens = emptyTokens();
  let workerCostUsd = 0;
  let context: ExtensionContext | undefined;
  let sequence = Date.now() * 1_000;
  let failed = false;
  let controller = new AbortController();
  let pending: MetadataTokens | undefined;
  let inFlight: Promise<void> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  const unsubscribers: Array<() => void> = [];

  function nextSequence(): number {
    sequence = Math.max(sequence + 1, Date.now() * 1_000);
    return sequence;
  }

  function warn(error: unknown, ctx: ExtensionContext): void {
    if (failed) return;
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Herdr metadata unavailable: ${message}`, "warning");
  }

  async function drain(): Promise<void> {
    try {
      while (pending && context) {
        const snapshot = pending;
        pending = undefined;
        const ctx = context;
        const signal = controller.signal;
        try {
          await reportMetadata(
            socketPath,
            {
              pane_id: paneId,
              source: SOURCE,
              seq: nextSequence(),
              ttl_ms: TTL_MS,
              tokens: snapshot,
            },
            signal,
          );
          failed = false;
        } catch (error) {
          if (!signal.aborted) warn(error, ctx);
        }
      }
    } finally {
      inFlight = undefined;
    }
  }

  function publish(): Promise<void> {
    if (!context) return Promise.resolve();
    const sessionCost = sumSessionUsage(context.sessionManager.getBranch()).cost;
    tokens.pi_cost = `$${(sessionCost + workerCostUsd).toFixed(3)}`;
    pending = { ...tokens };
    inFlight ??= drain();
    return inFlight;
  }

  function scheduleUpdate(): void {
    if (!context || debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      void publish();
    }, DEBOUNCE_MS);
    debounce.unref?.();
  }

  function subscribe(): void {
    if (unsubscribers.length > 0) return;
    for (const event of METADATA_EVENTS) {
      unsubscribers.push(
        pi.events.on(event, (data: unknown) => {
          const patch = eventTokens(event, data);
          if (!patch) return;
          const cost = event === "workers:state" ? (readWorkerCost(data) ?? 0) : workerCostUsd;
          const costChanged = cost !== workerCostUsd;
          workerCostUsd = cost;
          if (!costChanged && Object.entries(patch).every(([key, value]) => tokens[key] === value))
            return;
          Object.assign(tokens, patch);
          scheduleUpdate();
        }),
      );
    }
  }

  async function stop(): Promise<void> {
    const ctx = context;
    context = undefined;
    if (debounce) clearTimeout(debounce);
    if (refresh) clearInterval(refresh);
    debounce = undefined;
    refresh = undefined;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    pending = undefined;
    controller.abort();
    await inFlight;
    tokens = emptyTokens();
    workerCostUsd = 0;
    if (!ctx) return;
    try {
      await reportMetadata(socketPath, {
        pane_id: paneId,
        source: SOURCE,
        seq: nextSequence(),
        ttl_ms: TTL_MS,
        tokens,
      });
    } catch (error) {
      warn(error, ctx);
    }
  }

  // Capture startup announcements even when their session_start handlers run first.
  subscribe();

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (context) await stop();
    controller = new AbortController();
    failed = false;
    context = ctx;
    subscribe();
    await publish();
    if (context !== ctx || controller.signal.aborted) return;
    refresh = setInterval(() => {
      void publish();
    }, REFRESH_MS);
    refresh.unref?.();
  });

  pi.on("message_end", () => {
    scheduleUpdate();
  });

  pi.on("turn_end", () => {
    scheduleUpdate();
  });

  pi.on("session_shutdown", async () => {
    await stop();
  });
}
