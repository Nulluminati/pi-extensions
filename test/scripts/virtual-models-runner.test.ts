import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseOptions,
  planCases,
  workerParentPrompt,
} from "../../scripts/virtual-models-eval/plan.ts";
import { ExperimentStore } from "../../scripts/virtual-models-eval/store.ts";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-virtual-store-test-"));
  cleanups.push(path);
  return path;
}

describe("virtual-model runner plan and checkpoints", () => {
  it("defaults to four unscored smoke cases and plans exactly 48 unique scored cases", () => {
    expect(planCases(parseOptions([]))).toHaveLength(4);
    const cases = planCases(parseOptions(["--phase", "scored"]));
    expect(cases).toHaveLength(48);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(48);
    expect(cases.filter((entry) => entry.role === "worker")).toHaveLength(18);
    expect(cases.filter((entry) => entry.role === "main")).toHaveLength(30);
    expect(
      new Set(cases.filter((entry) => entry.role === "worker").map((entry) => entry.parentModel)),
    ).toEqual(new Set(["openai-codex/gpt-6.1-sol"]));
    expect(
      cases
        .filter((entry) => entry.role === "main")
        .every((entry) => entry.workerModel === "zai/glm-5.3-flash"),
    ).toBe(true);
  });
  it("rotates arm order by task and supports task, arm, role, repetition, and output filters", () => {
    const options = parseOptions([
      "--phase",
      "scored",
      "--tasks",
      "fix,rename",
      "--arms",
      "glm,rules",
      "--roles",
      "worker",
      "--repetitions",
      "1",
      "--output-dir",
      "/tmp/output",
    ]);
    const cases = planCases(options);
    expect(cases.map((entry) => entry.arm)).toEqual(["glm", "rules", "rules", "glm"]);
    expect(options.outputDir).toBe("/tmp/output");
    expect(cases.every((entry) => entry.parentModel === "openai-codex/gpt-6.1-sol")).toBe(true);
    expect(() => parseOptions(["--roles", "unknown"])).toThrow();
    expect(() => parseOptions(["--tasks", "fix,fix"])).toThrow();
    expect(() => parseOptions(["--repetitions", "0"])).toThrow();
    expect(() => parseOptions(["--output-dir", "x", "--resume", "y"])).toThrow();
  });
  it("preserves the exact worker assignment and requires isolated writable workers", () => {
    const cases = planCases(
      parseOptions(["--phase", "scored", "--roles", "worker", "--tasks", "fix", "--arms", "rules"]),
    );
    const item = cases[0];
    if (!item) throw new Error("Missing case");
    const prompt = workerParentPrompt(item);
    expect(prompt).toContain("isolate:true");
    expect(prompt).toContain("read_only:false");
    expect(prompt).toContain("collect");
    expect(prompt).toContain(JSON.stringify(item.assignment));
  });
  it("uses an isolated writable worker for diagnostic test caches without permitting source edits", () => {
    const item = planCases(
      parseOptions([
        "--phase",
        "scored",
        "--roles",
        "worker",
        "--tasks",
        "diagnosis",
        "--arms",
        "glm",
      ]),
    )[0];
    if (!item) throw new Error("Missing diagnostic case");
    expect(workerParentPrompt(item)).toContain("isolate:true");
    expect(workerParentPrompt(item)).toContain("read_only:false");
    expect(item.assignment).toContain("Do not fix or edit anything");
  });

  it("saves the manifest before attempts and never reruns completed failed or passed cases", async () => {
    const path = await directory();
    const cases = planCases(parseOptions([]));
    const store = await ExperimentStore.create(path, {
      fingerprint: "policy-v1",
      configurations: { settings: "hash" },
      cases,
      phase: "smoke",
    });
    expect(JSON.parse(await readFile(join(path, "manifest.json"), "utf8")).fingerprint).toBe(
      "policy-v1",
    );
    const first = await store.start(cases[0]);
    await store.finish(first.id, {
      status: "completed",
      passed: false,
      reason: "independent task failure",
    });
    expect(store.pending(cases).map((entry) => entry.id)).not.toContain(cases[0]?.id);
    await expect(store.start(cases[0])).rejects.toThrow("already completed");
  });
  it("retains exhausted and interrupted attempts and resumes with new provenance", async () => {
    const path = await directory();
    const cases = planCases(parseOptions([]));
    const store = await ExperimentStore.create(path, {
      fingerprint: "policy-v1",
      configurations: {},
      cases,
      phase: "smoke",
    });
    const first = await store.start(cases[0]);
    await store.finish(first.id, {
      status: "interrupted",
      passed: false,
      reason: "quota exhausted",
    });
    await store.start(cases[1]);
    const resumed = await ExperimentStore.resume(path, "policy-v1", {});
    const retry = await resumed.start(cases[0]);
    expect(retry.attempt).toBe(2);
    expect(retry.previousAttempt).toBe(first.id);
    expect(resumed.attempts.find((entry) => entry.caseId === cases[1]?.id)?.status).toBe(
      "interrupted",
    );
    expect(resumed.attempts).toHaveLength(3);
    await expect(ExperimentStore.resume(path, "changed-policy", {})).rejects.toThrow("fingerprint");
    await expect(ExperimentStore.resume(path, "policy-v1", { changed: "hash" })).rejects.toThrow(
      "configuration",
    );
  });
});
