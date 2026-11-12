import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const secretsJob = workflow.split("\n  secrets:\n")[1];
const topLevelPermissions = workflow.split("\npermissions:\n")[1]?.split("\n\n")[0];

describe("secret scanning compatibility", () => {
  it("pins a CI scanner that supports top-level allowlists", () => {
    expect(secretsJob).toBeDefined();
    const version = secretsJob?.match(/GITLEAKS_VERSION:\s*"(\d+)\.(\d+)\.(\d+)"/);
    expect(version, "Pin the Gitleaks release that CI downloads").not.toBeNull();
    const [major, minor] = (version?.slice(1, 3) ?? []).map(Number);
    expect(major > 8 || (major === 8 && minor >= 25)).toBe(true);
  });

  it("verifies the downloaded scanner instead of using gitleaks-action", () => {
    expect(workflow).not.toContain("gitleaks/gitleaks-action");
    expect(secretsJob).toMatch(/GITLEAKS_SHA256:\s*"[0-9a-f]{64}"/);
    expect(secretsJob).toContain("sha256sum -c -");
  });

  it("grants the workflow token read access to contents only", () => {
    expect(topLevelPermissions?.trim()).toBe("contents: read");
  });

  it("documents the minimum local scanner version", () => {
    expect(readme).toContain("Gitleaks 8.25.0 or later");
  });
});
