/** Execution receipts distinguish an actual fixture failure from a test-runner startup error. */
import { DIAGNOSIS_PATH } from "./tasks.ts";

export function hasExpectedDiagnosisFailure(
  commands: readonly string[],
  assertionFailures: readonly string[],
): boolean {
  return (
    commands.some((command) => command.includes("vitest") && command.includes(DIAGNOSIS_PATH)) &&
    assertionFailures.some(
      (text) =>
        text.includes("pilot fixed precision") &&
        text.includes("AssertionError") &&
        text.includes("1.0k") &&
        /["']1k["']/.test(text),
    )
  );
}
