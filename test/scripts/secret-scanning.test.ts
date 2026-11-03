import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("secret scanning compatibility", () => {
  it("pins a CI scanner that supports top-level allowlists", () => {
    const actionStep = workflow.split("- name: Run gitleaks")[1]?.split("\n      - name:")[0];
    expect(actionStep).toBeDefined();
    const version = actionStep?.match(/GITLEAKS_VERSION:\s*"(\d+)\.(\d+)\.(\d+)"/);
    expect(
      version,
      "Pin Gitleaks instead of using the action's incompatible default",
    ).not.toBeNull();
    const [major, minor] = (version?.slice(1, 3) ?? []).map(Number);
    expect(major > 8 || (major === 8 && minor >= 25)).toBe(true);
  });

  it("documents the minimum local scanner version", () => {
    expect(readme).toContain("Gitleaks 8.25.0 or later");
  });
});
