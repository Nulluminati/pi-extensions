/** Mirror the Pi session name onto the adapter's own Herdr pane label. */

import { requestHerdr } from "./client.ts";

const TIMEOUT_MS = 1_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paneId(result: Record<string, unknown>): string {
  const pane = result.pane;
  if (!record(pane) || typeof pane.pane_id !== "string" || !pane.pane_id)
    throw new Error("Herdr returned an invalid pane identifier");
  return pane.pane_id;
}

// An absent or blank name asks for a clear; null marks that clear intent.
function requestedLabel(name: unknown): string | null {
  return typeof name === "string" && name.trim() ? name : null;
}

export function createPaneNameSync(options: {
  socketPath: string;
  parentPaneId: string;
  signal: AbortSignal;
  ok(): void;
  warn(error: unknown): void;
}): {
  sync(name: unknown): void;
  stop(): Promise<void>;
} {
  const { socketPath, parentPaneId, signal, ok, warn } = options;
  let stopped = false;
  // The last label this adapter confirmed, or null after an explicit clear.
  let applied: string | null | undefined;
  let pending: string | null | undefined;
  let writing: string | null | undefined;
  let running: Promise<void> | undefined;

  async function apply(label: string | null): Promise<void> {
    // pane.current resolves the canonical identifier after the pane moved.
    const current = await requestHerdr(
      socketPath,
      "pane.current",
      { caller_pane_id: parentPaneId },
      { signal, timeoutMs: TIMEOUT_MS },
    );
    if (stopped) return;
    if (pending !== undefined) {
      label = pending;
      pending = undefined;
      writing = label;
    }
    if (label === null && applied === undefined) return;
    await requestHerdr(
      socketPath,
      "pane.rename",
      { pane_id: paneId(current), label: label ?? "" },
      { signal, timeoutMs: TIMEOUT_MS },
    );
    if (stopped) return;
    applied = label;
    ok();
  }

  async function drain(): Promise<void> {
    try {
      while (pending !== undefined && !stopped) {
        const label = pending;
        pending = undefined;
        writing = label;
        try {
          await apply(label);
        } catch (error) {
          if (!signal.aborted && !stopped) warn(error);
        } finally {
          writing = undefined;
        }
      }
    } finally {
      running = undefined;
    }
  }

  function sync(name: unknown): void {
    if (stopped) return;
    const label = requestedLabel(name);
    if (writing !== undefined) {
      // Keep only the newest name; a duplicate of the in-flight write adds nothing.
      pending = writing !== label ? label : undefined;
      return;
    }
    if (pending !== undefined) {
      if (pending !== label) pending = label;
      return;
    }
    // Clear only a label this adapter set during the active session.
    if (label === null && applied === undefined) return;
    if (applied !== undefined && applied === label) return;
    pending = label;
    running ??= drain();
  }

  async function stop(): Promise<void> {
    stopped = true;
    pending = undefined;
    await running;
    applied = undefined;
  }

  return { sync, stop };
}
