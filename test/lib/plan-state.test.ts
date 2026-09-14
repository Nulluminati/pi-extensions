import { describe, expect, it } from "vitest";
import {
  isPlanModeActive,
  PLAN_STATE_ENTRY_TYPE,
  type PlanState,
  reconstructState,
} from "../../lib/plan-state.ts";

describe("plan-state parser", () => {
  it("reconstructState returns the state from a valid plan-state entry", () => {
    const state: PlanState = {
      mode: "executing",
      plan: { title: "Migrate auth", steps: ["map storage", "swap module"] },
      toolsBeforePlan: ["edit", "write"],
    };

    expect(reconstructState([entry(state)])).toEqual(state);
  });

  it("reconstructState returns undefined when no plan-state entry exists", () => {
    expect(reconstructState([])).toBeUndefined();
    expect(
      reconstructState([{ type: "custom", customType: "other-state", data: { state: {} } }]),
    ).toBeUndefined();
  });

  it("reconstructState rejects unknown modes and invalid plan shapes", () => {
    expect(reconstructState([entry(undefined)])).toBeUndefined();
    expect(reconstructState([entry({ mode: "paused", plan: null })])).toBeUndefined();
    expect(
      reconstructState([entry({ mode: "plan", plan: { title: 7, steps: ["a"] } })]),
    ).toBeUndefined();
    expect(
      reconstructState([entry({ mode: "plan", plan: { title: "T", steps: [] } })]),
    ).toBeUndefined();
    expect(
      reconstructState([entry({ mode: "plan", plan: { title: "T", steps: ["a", 2] } })]),
    ).toBeUndefined();
    expect(
      reconstructState([entry({ mode: "plan", plan: null, toolsBeforePlan: "edit" })]),
    ).toBeUndefined();
  });

  it("reconstructState picks the newest entry", () => {
    const entries = [
      entry({ mode: "plan", plan: { title: "first", steps: ["a"] } }),
      entry({ mode: "executing", plan: { title: "second", steps: ["b"] }, toolsBeforePlan: [] }),
    ];

    expect(reconstructState(entries)?.mode).toBe("executing");
    expect(reconstructState(entries)?.plan?.title).toBe("second");
  });

  it("isPlanModeActive is true only for mode plan", () => {
    for (const mode of ["off", "executing", "readonly"] as const) {
      expect(isPlanModeActive([entry({ mode, plan: null })])).toBe(false);
    }

    expect(isPlanModeActive([entry({ mode: "plan", plan: null })])).toBe(true);
    expect(isPlanModeActive([])).toBe(false);
  });
});

function entry(state: unknown): { type: string; customType: string; data: unknown } {
  return { type: "custom", customType: PLAN_STATE_ENTRY_TYPE, data: { state } };
}
