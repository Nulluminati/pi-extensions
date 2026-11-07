import { describe, expect, it } from "vitest";
import {
  checkAnswer,
  fixtures,
  optimalMakespan,
  REVIEW_PATCH,
  SCHEDULE_GRAPH,
  taskSetup,
} from "../../scripts/virtual-models-eval/tasks.ts";

const answer = (value: unknown) => `VIRTUAL_RESULT=${JSON.stringify(value)}`;

describe("frozen virtual-model pilot fixtures", () => {
  it("defines six bounded main/worker tasks without exposing checker answers or difficulty labels", () => {
    expect(fixtures.map((task) => task.id)).toEqual([
      "boundaries",
      "diagnosis",
      "fix",
      "rename",
      "review",
      "schedule",
    ]);
    for (const task of fixtures) {
      expect(task.mainPrompt.length).toBeGreaterThan(150);
      expect(task.workerPrompt.length).toBeGreaterThan(150);
      expect(task.timeoutMs).toBeGreaterThanOrEqual(240000);
      expect(task.mainPrompt).not.toMatch(/expectedAnswer|difficulty:/);
      expect(task.workerPrompt).not.toContain("spawn_worker");
    }
    expect(fixtures[0]?.mainPrompt).toContain("spawn_worker");
  });

  it("defines deterministic setup without copying checking rules into a task workspace", () => {
    const sources = { "lib/arrow-keys.ts": 'return data === "\\u001b[D" || data === "\\u001bOD";' };
    expect(taskSetup("fix", sources)).toEqual({
      "lib/arrow-keys.ts": 'return data === "\\u001b[D" || data === "\\u001bOC";',
    });
    expect(taskSetup("diagnosis", {})).toHaveProperty(
      "test/extensions/virtual-pilot-probe.test.ts",
    );
    expect(taskSetup("schedule", {})).toEqual({
      ".pi/virtual-models-task/graph.json": JSON.stringify(SCHEDULE_GRAPH, null, 2),
    });
    expect(Object.keys(taskSetup("review", {}))).toEqual([
      ".pi/virtual-models-task/proposal.patch",
    ]);
    expect(taskSetup("rename", {})).toEqual({});
    expect(() => taskSetup("fix", {})).toThrow("Pinned arrow-key source");
  });

  it("checks exact repository boundary facts and rejects duplicates and missing keys", () => {
    const facts = {
      required: ["messenger", "worker-blocker", "approval-mode", "worker-sandbox"],
      forbidden: ["workers", "missions", "autoresearch"],
      extensionPrecedence: ["explicit", "environment", "config", "default"],
      modelPrecedence: ["environment", "config"],
      sandboxLast: true,
    };
    expect(checkAnswer("boundaries", answer(facts)).passed).toBe(true);
    expect(
      checkAnswer("boundaries", answer({ ...facts, required: [...facts.required, "messenger"] }))
        .passed,
    ).toBe(false);
    expect(checkAnswer("boundaries", answer({ ...facts, sandboxLast: false })).passed).toBe(false);
  });

  it("requires diagnosis evidence from an executed test, not just a guessed answer", () => {
    const diagnosis = { testName: "pilot fixed precision", expected: "1k", actual: "1.0k" };
    expect(checkAnswer("diagnosis", answer(diagnosis)).passed).toBe(false);
    expect(checkAnswer("diagnosis", answer(diagnosis), { diagnosisExecuted: true }).passed).toBe(
      true,
    );
    expect(
      checkAnswer("diagnosis", answer({ ...diagnosis, actual: "1000" }), {
        diagnosisExecuted: true,
      }).passed,
    ).toBe(false);
  });

  it("requires independent patch checks for both edit tasks", () => {
    expect(checkAnswer("fix", answer({ fixed: true }), { patchPassed: true }).passed).toBe(true);
    expect(checkAnswer("fix", answer({ fixed: true })).passed).toBe(false);
    expect(checkAnswer("rename", answer({ renamed: true })).passed).toBe(false);
    expect(checkAnswer("rename", answer({ renamed: true }), { patchPassed: true }).passed).toBe(
      true,
    );
  });

  it("accepts only the three constraint violations in the supplied review patch", () => {
    expect(REVIEW_PATCH).toContain("+const FORBIDDEN_WORKER_EXTENSIONS = [];");
    const findings = ["nested-delegation", "sandbox-order", "approval-bypass"];
    expect(checkAnswer("review", answer({ findings })).passed).toBe(true);
    expect(checkAnswer("review", answer({ findings: [...findings, "style-only"] })).passed).toBe(
      false,
    );
    expect(checkAnswer("review", answer({ findings: findings.slice(1) })).passed).toBe(false);
  });

  it("independently solves scheduling and rejects infeasible claimed optima", () => {
    const result = optimalMakespan(SCHEDULE_GRAPH);
    expect(result.makespan).toBe(18);
    expect(result.schedule).toHaveLength(SCHEDULE_GRAPH.length);
    expect(checkAnswer("schedule", answer(result)).passed).toBe(true);
    expect(
      checkAnswer(
        "schedule",
        answer({
          makespan: 19,
          schedule: result.schedule.map((row) => ({ ...row, start: row.start + 1 })),
        }),
      ).passed,
    ).toBe(false);
    expect(
      checkAnswer("schedule", answer({ ...result, makespan: result.makespan - 1 })).passed,
    ).toBe(false);
    expect(
      checkAnswer(
        "schedule",
        answer({
          makespan: result.makespan,
          schedule: result.schedule.map((row) => ({ ...row, start: 0 })),
        }),
      ).passed,
    ).toBe(false);
  });

  it("rejects malformed and ambiguous final output", () => {
    expect(checkAnswer("review", "no result").passed).toBe(false);
    expect(checkAnswer("review", "VIRTUAL_RESULT={").passed).toBe(false);
    expect(checkAnswer("review", `${answer({})}\n${answer({})}`).passed).toBe(false);
  });
});
