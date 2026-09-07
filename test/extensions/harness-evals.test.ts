import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarize } from "../../extensions/harness-evals/src/format.ts";
import {
  materializeTask,
  runCheck,
  runEvalTask,
  runPiSession,
} from "../../extensions/harness-evals/src/runner.ts";
import { BUILT_IN_TASKS, findTask } from "../../extensions/harness-evals/src/tasks.ts";

// --- Canonical solutions used to validate the checks themselves ---

const BUGFIX_SOLUTION = `function average(nums) {
  let total = 0;
  for (let i = 0; i < nums.length; i++) {
    total += nums[i];
  }
  return total / nums.length;
}

module.exports = { average };
`;

const RENAME_FILES: Array<[string, string]> = [
  [
    "format.js",
    `function formatCurrency(cents) {\n  return "$" + (cents / 100).toFixed(2);\n}\n\nmodule.exports = { formatCurrency };\n`,
  ],
  [
    "invoice.js",
    `const { formatCurrency } = require("./format.js");\n\nfunction invoiceLine(label, cents) {\n  return label + ": " + formatCurrency(cents);\n}\n\nmodule.exports = { invoiceLine };\n`,
  ],
  [
    "report.js",
    `const { formatCurrency } = require("./format.js");\n\nfunction totalLine(cents) {\n  return "TOTAL " + formatCurrency(cents);\n}\n\nmodule.exports = { totalLine };\n`,
  ],
];

const DIAGNOSIS_SOLUTION = `function double(n) {\n  return n * 2;\n}\n\nmodule.exports = { double };\n`;

const SLUGIFY_SOLUTION = `function slugify(text) {
  let s = text.trim().toLowerCase();
  s = s.replace(/[^a-z0-9\\s]/g, " ");
  s = s.trim().replace(/\\s+/g, "-");
  return s;
}

module.exports = { slugify };
`;

const PARSE_SOLUTION = `function parseCount(text) {
  const n = Number(String(text).replace(/,/g, ""));
  if (Number.isNaN(n)) {
    throw new Error("not a number: " + JSON.stringify(text));
  }
  return n;
}

module.exports = { parseCount };
`;

const PARSE_REGRESSION_TEST = `const assert = require("node:assert");
const { parseCount } = require("./parse.js");

assert.strictEqual(parseCount("7"), 7);
assert.strictEqual(parseCount("1,234"), 1234, "thousands separators must parse");
console.log("parse tests passed");
`;

// --- Suite ---

describe("harness-evals-tasks", () => {
  it("has unique task ids with checks", () => {
    const ids = BUILT_IN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of BUILT_IN_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(20);
      expect(task.checks.command.length).toBeGreaterThan(10);
    }
  });

  const checkFails = async (taskId: string) => {
    const task = findTask(taskId);
    if (!task) throw new Error(taskId);
    const ws = await materializeTask(task);
    try {
      return (await runCheck(task.checks, ws.dir)).ok;
    } finally {
      await ws.cleanup();
    }
  };

  const checkPassesWith = async (taskId: string, mutate: (dir: string) => Promise<void>) => {
    const task = findTask(taskId);
    if (!task) throw new Error(taskId);
    const ws = await materializeTask(task);
    try {
      await mutate(ws.dir);
      return (await runCheck(task.checks, ws.dir)).ok;
    } finally {
      await ws.cleanup();
    }
  };

  it("bugfix-regression: check rejects fixtures and accepts the real fix", async () => {
    expect(await checkFails("bugfix-regression")).toBe(false);
    expect(
      await checkPassesWith("bugfix-regression", (dir) =>
        writeFile(join(dir, "stats.js"), BUGFIX_SOLUTION),
      ),
    ).toBe(true);
  });

  it("multi-file-rename: check rejects partial and accepts full rename", async () => {
    expect(await checkFails("multi-file-rename")).toBe(false);
    // Partial rename (format.js only) must still fail.
    const partialOk = await checkPassesWith("multi-file-rename", (dir) =>
      writeFile(join(dir, "format.js"), RENAME_FILES[0][1]),
    );
    expect(partialOk).toBe(false);
    const fullOk = await checkPassesWith("multi-file-rename", async (dir) => {
      for (const [path, content] of RENAME_FILES) {
        await writeFile(join(dir, path), content);
      }
    });
    expect(fullOk).toBe(true);
  });

  it("misleading-diagnosis: check rejects fixtures and accepts fixing double()", async () => {
    expect(await checkFails("misleading-diagnosis")).toBe(false);
    // "Fixing" the wrong module (mathx) must still fail the check.
    const wrongModule = await checkPassesWith("misleading-diagnosis", (dir) =>
      writeFile(
        join(dir, "mathx.js"),
        `function halve(n) { return n * 2; }\nmodule.exports = { halve };\n`,
      ),
    );
    expect(wrongModule).toBe(false);
    expect(
      await checkPassesWith("misleading-diagnosis", (dir) =>
        writeFile(join(dir, "scale.js"), DIAGNOSIS_SOLUTION),
      ),
    ).toBe(true);
  });

  it("implement-to-spec: check rejects stubs and accepts a correct slugify", async () => {
    expect(await checkFails("implement-to-spec")).toBe(false);
    expect(
      await checkPassesWith("implement-to-spec", (dir) =>
        writeFile(join(dir, "slug.js"), SLUGIFY_SOLUTION),
      ),
    ).toBe(true);
  });

  it("test-first-bugfix: check demands both a fix and a catching regression test", async () => {
    expect(await checkFails("test-first-bugfix")).toBe(false);
    // Fix without a regression test: the swap check must reject it.
    const fixOnly = await checkPassesWith("test-first-bugfix", async (dir) => {
      await writeFile(join(dir, "parse.js"), PARSE_SOLUTION);
      await writeFile(
        join(dir, "parse.test.js"),
        `const assert = require("node:assert");\nconst { parseCount } = require("./parse.js");\nassert.strictEqual(parseCount("7"), 7);\nconsole.log("ok");\n`,
      );
    });
    expect(fixOnly).toBe(false);
    // Regression test + fix must pass.
    const withTest = await checkPassesWith("test-first-bugfix", async (dir) => {
      await writeFile(join(dir, "parse.js"), PARSE_SOLUTION);
      await writeFile(join(dir, "parse.test.js"), PARSE_REGRESSION_TEST);
    });
    expect(withTest).toBe(true);
  });
});

// --- Runner ---

describe("harness-evals-runner", () => {
  it("runPiSession parses usage and final text from a fixture pi binary", async () => {
    const fixture = join(import.meta.dirname ?? ".", "fixture-pi.sh");
    await writeFile(
      fixture,
      `#!/bin/sh\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"session done"}],"usage":{"input":120,"output":30}}}'\n`,
    );
    await chmod(fixture, 0o755);
    try {
      const outcome = await runPiSession({
        cwd: process.cwd(),
        prompt: "ignored",
        timeoutMs: 10_000,
        extensionPaths: [],
        piBin: fixture,
      });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.finalText).toBe("session done");
      expect(outcome.inputTokens).toBe(120);
      expect(outcome.outputTokens).toBe(30);
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(fixture, { force: true }));
    }
  });

  it("runEvalTask grades a fixture worker that solves bugfix-regression", async () => {
    const task = findTask("bugfix-regression");
    if (!task) throw new Error("missing task");
    const fixture = join(import.meta.dirname ?? ".", "fixture-pi-solve.sh");
    await writeFile(
      fixture,
      `#!/bin/sh\ncat > prompt.dump <<'EOF'\n$1\nEOF\nnode -e 'const fs=require("fs");let s=fs.readFileSync("stats.js","utf8");s=s.replace("i <= nums.length","i < nums.length");fs.writeFileSync("stats.js",s);'\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I fixed the off-by-one."}],"usage":{"input":500,"output":40}}}'\n`,
    );
    await chmod(fixture, 0o755);
    try {
      const result = await runEvalTask(task, { piBin: fixture, model: "fixture/test" });
      expect(result.pass).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.outputTokens).toBe(40);
      expect(result.finalText).toContain("off-by-one");
      expect(result.checks[0].ok).toBe(true);
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(fixture, { force: true }));
    }
  });

  it("runEvalTask fails a fixture worker that changes nothing", async () => {
    const task = findTask("bugfix-regression");
    if (!task) throw new Error("missing task");
    const fixture = join(import.meta.dirname ?? ".", "fixture-pi-noop.sh");
    await writeFile(
      fixture,
      `#!/bin/sh\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I could not fix it."}]}}'\n`,
    );
    await chmod(fixture, 0o755);
    try {
      const result = await runEvalTask(task, { piBin: fixture, model: "fixture/test" });
      expect(result.pass).toBe(false);
      expect(result.checks[0].ok).toBe(false);
    } finally {
      await import("node:fs/promises").then((fs) => fs.rm(fixture, { force: true }));
    }
  });

  it("summarize aggregates pass rate and per-task stats", () => {
    const summary = summarize([
      fakeResult("a", true),
      fakeResult("a", false),
      fakeResult("b", true),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.passes).toBe(2);
    expect(summary.passRate).toBeCloseTo(2 / 3);
    expect(summary.byTask.find((t) => t.taskId === "a")?.runs).toBe(2);
  });

  function fakeResult(taskId: string, pass: boolean) {
    return {
      taskId,
      model: "m",
      pass,
      checks: [{ name: "c", ok: pass, output: pass ? "passed" : "failed" }],
      durationMs: 1000,
      exitCode: 0,
      timedOut: false,
      inputTokens: 10,
      outputTokens: 20,
      at: 0,
    };
  }
});
