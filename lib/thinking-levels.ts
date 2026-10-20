/**
 * Shared thinking-level vocabulary.
 *
 * Small-model config, worker-model config, and the small-model status
 * extension validate against one Set so a level accepted by one surface is
 * accepted by all of them.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The thinking levels Pi accepts, in ascending order of depth. */
export const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
