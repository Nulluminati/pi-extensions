import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sumUsage, type Usage } from "../../scripts/virtual-models-eval/ledger.ts";

type Row = {
  id: string;
  role: string;
  task: string;
  arm: string;
  passed: boolean;
  models: string[];
  focusUsage: Usage;
  totalUsage: Usage;
  focusKnownLowerBoundUsage: Usage;
  totalKnownLowerBoundUsage: Usage;
  retries: number;
  requestedThinking: string;
  literalChatMatchesAggregate: boolean | null;
};
type Group = {
  role: string;
  arm: string;
  cases: number;
  passed: number;
  focusUsage: Usage;
  focusKnownLowerBoundUsage: Usage;
  totalUsage: Usage;
  totalKnownLowerBoundUsage: Usage;
};
type Evidence = {
  versions: { fingerprints: string[] };
  planned: number;
  completed: number;
  passed: number;
  pending: string[];
  originalConfigurationUnchanged: boolean;
  cases: Row[];
  groups: Group[];
  invalidated: Array<{ originalPassed: boolean; correctedTotalUsage: Usage }>;
  interrupted: Array<{ correctedTotalUsage: Usage }>;
  smoke: unknown[];
  pairedDifferences: Array<{ available: boolean }>;
};
async function evidence(): Promise<Evidence> {
  return JSON.parse(
    await readFile(new URL("../../docs/virtual-models-pilot.json", import.meta.url), "utf8"),
  );
}

describe("frozen virtual-model pilot evidence", () => {
  it("contains all 48 unique cases and retains strict-contract failures and infrastructure expense", async () => {
    const data = await evidence();
    const tasks = ["boundaries", "diagnosis", "fix", "rename", "review", "schedule"];
    const expected = ["main", "worker"].flatMap((role) =>
      tasks.flatMap((task) =>
        (role === "main"
          ? ["sol", "deepseek", "glm", "rules", "jev"]
          : ["glm", "rules", "jev"]
        ).map((arm) => `${role}-${task}-${arm}-r1`),
      ),
    );
    expect(data.cases.map((row) => row.id).sort()).toEqual(expected.sort());
    expect(new Set(data.cases.map((row) => row.id)).size).toBe(48);
    expect(data.planned).toBe(48);
    expect(data.completed).toBe(48);
    expect(data.passed).toBe(46);
    expect(data.pending).toEqual([]);
    expect(
      data.cases
        .filter((row) => !row.passed)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["main-diagnosis-glm-r1", "worker-rename-glm-r1"]);
    expect(data.invalidated).toHaveLength(1);
    expect(data.invalidated[0].originalPassed).toBe(true);
    expect(data.invalidated[0].correctedTotalUsage.aggregate).toBe(166314);
    expect(data.interrupted).toHaveLength(3);
    expect(data.smoke).toHaveLength(9);
    expect(data.originalConfigurationUnchanged).toBe(true);
    const compatibility = JSON.parse(
      await readFile(
        new URL("../../docs/virtual-models-compatibility.json", import.meta.url),
        "utf8",
      ),
    );
    expect(compatibility.approvedBy).toBe("Zero Cool");
    expect(compatibility.scope).toBe("infrastructure-repair-only");
    expect(compatibility.allowedFingerprints.sort()).toEqual(
      [...data.versions.fingerprints].sort(),
    );
    expect(data.pairedDifferences).toHaveLength(48);
    expect(data.pairedDifferences.every((pair) => pair.available)).toBe(true);
  });
  it("reconciles all group totals and category lower bounds without turning missing usage into zero", async () => {
    const data = await evidence();
    for (const group of data.groups) {
      const rows = data.cases.filter((row) => row.role === group.role && row.arm === group.arm);
      expect(rows).toHaveLength(6);
      expect(group.passed).toBe(rows.filter((row) => row.passed).length);
      expect(group.focusUsage).toEqual(sumUsage(rows.map((row) => row.focusUsage)));
      expect(group.totalUsage).toEqual(sumUsage(rows.map((row) => row.totalUsage)));
      expect(group.focusKnownLowerBoundUsage).toEqual(
        sumUsage(rows.map((row) => row.focusKnownLowerBoundUsage)),
      );
      expect(group.totalKnownLowerBoundUsage).toEqual(
        sumUsage(rows.map((row) => row.totalKnownLowerBoundUsage)),
      );
    }
    const unknown = data.cases.filter((row) => row.focusUsage.aggregate === null);
    expect(unknown.map((row) => row.id)).toEqual(["worker-diagnosis-jev-r1"]);
    expect(unknown[0].passed).toBe(true);
    expect(unknown[0].retries).toBe(1);
    expect(unknown[0].focusKnownLowerBoundUsage.aggregate).toBe(41160);
    expect(
      data.cases
        .filter((row) => row.focusUsage.aggregate !== null)
        .every((row) => row.literalChatMatchesAggregate),
    ).toBe(true);
    expect(
      data.interrupted.filter((row) => row.correctedTotalUsage.aggregate === null),
    ).toHaveLength(2);
  });
  it("records identical rule and Jev choices for both roles and keeps requested thinking explicit", async () => {
    const data = await evidence();
    const pool = [
      "openai-codex/gpt-6.1-sol",
      "opencode-go/deepseek-v4.1-flash",
      "zai/glm-5.3-flash",
    ];
    for (const row of data.cases) {
      expect(row.models).toHaveLength(1);
      expect(pool).toContain(row.models[0]);
      expect(row.requestedThinking).toBe(row.role === "main" ? "medium" : "high");
      if (row.arm === "rules")
        expect(
          data.cases.find(
            (other) => other.role === row.role && other.task === row.task && other.arm === "jev",
          )?.models,
        ).toEqual(row.models);
    }
  });
});
