import { describe, expect, it } from "vitest";
import { THINKING_LEVELS as EXTENSION_LEVELS } from "../../extensions/small-model/src/constants.ts";
import { THINKING_LEVELS } from "../../lib/thinking-levels.ts";
import { isWorkerThinkingLevel } from "../../lib/worker-model.ts";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

describe("thinking levels", () => {
  it("lists the seven levels Pi accepts, in ascending order", () => {
    expect([...THINKING_LEVELS]).toEqual([...ALL_LEVELS]);
  });

  it("is the same Set every consumer imports", () => {
    // A second copy could drift from the first; identity is the guard.
    expect(EXTENSION_LEVELS).toBe(THINKING_LEVELS);
  });

  it("worker-model validation accepts exactly these levels", () => {
    for (const level of ALL_LEVELS) expect(isWorkerThinkingLevel(level)).toBe(true);
    expect(isWorkerThinkingLevel("extreme")).toBe(false);
    expect(isWorkerThinkingLevel("")).toBe(false);
  });
});
