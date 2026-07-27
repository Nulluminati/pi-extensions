import type { ThinkingLevel } from "pi";

export const STATUS_ICON = String.fromCodePoint(0xf09d1); // nf-md-brain
export const STATUS_KEY = "small-model";
export const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
