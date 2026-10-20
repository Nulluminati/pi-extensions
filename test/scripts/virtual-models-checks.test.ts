import { describe, expect, it } from "vitest";
import { hasExpectedDiagnosisFailure } from "../../scripts/virtual-models-eval/checks.ts";

describe("diagnostic execution evidence", () => {
  const commands = ["npx vitest run test/extensions/virtual-pilot-probe.test.ts"];
  const failure =
    "FAIL test/extensions/virtual-pilot-probe.test.ts > pilot fixed precision\nAssertionError: expected '1.0k' to be '1k' // Object.is equality";
  it("requires the real expected assertion failure as well as a test command", () => {
    expect(hasExpectedDiagnosisFailure(commands, [failure])).toBe(true);
    expect(hasExpectedDiagnosisFailure(commands, [])).toBe(false);
    expect(hasExpectedDiagnosisFailure([], [failure])).toBe(false);
    expect(
      hasExpectedDiagnosisFailure(commands, ["failed to load config: Cannot find package vitest"]),
    ).toBe(false);
    expect(
      hasExpectedDiagnosisFailure(commands, [
        failure.replace("pilot fixed precision", "other test"),
      ]),
    ).toBe(false);
  });
});
