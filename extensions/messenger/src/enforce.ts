/** Reservation enforcement for tool calls. Pure function so tests can cover
 * it without spawning sessions. Scope: the `edit` and `write` built-in tools
 * only — bash-based writes are NOT enforced (documented limitation; run
 * untrusted workers in a sandbox or worktree). */

import { findBlockingReservation, type ReservationBlock } from "./store.ts";
import type { ReservationMap } from "./types.ts";

// --- Enforcement ---

const GUARDED_TOOLS = new Set(["edit", "write"]);

export function checkToolCall(
  toolName: string,
  params: Record<string, unknown>,
  cwd: string,
  selfName: string,
  reservations: ReservationMap,
): ReservationBlock | undefined {
  if (!GUARDED_TOOLS.has(toolName)) return undefined;
  const path = typeof params.path === "string" ? params.path : undefined;
  if (!path) return undefined;
  return findBlockingReservation(cwd, path, selfName, reservations);
}
