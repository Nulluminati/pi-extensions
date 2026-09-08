import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarize } from "../../extensions/harness-evals/src/format.ts";
import {
  collectWorkspace,
  materializeTask,
  parseJudgeVerdict,
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

// --- Advanced task solutions ---

const REFACTOR_FILES: Array<[string, string]> = [
  [
    "math-basic.js",
    `function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n\nfunction lerp(a, b, t) {\n  return a + (b - a) * t;\n}\n\nfunction roundTo(n, places) {\n  const f = 10 ** places;\n  return Math.round(n * f) / f;\n}\n\nmodule.exports = { clamp, lerp, roundTo };\n`,
  ],
  [
    "stats.js",
    `function sum(nums) {\n  return nums.reduce((a, b) => a + b, 0);\n}\n\nfunction mean(nums) {\n  return nums.length === 0 ? 0 : sum(nums) / nums.length;\n}\n\nfunction stddev(nums) {\n  if (nums.length === 0) return 0;\n  const m = mean(nums);\n  return Math.sqrt(mean(nums.map((x) => (x - m) ** 2)));\n}\n\nmodule.exports = { sum, mean, stddev };\n`,
  ],
  [
    "util.js",
    `module.exports = {\n  ...require("./math-basic.js"),\n  ...require("./stats.js"),\n};\n`,
  ],
];

const LRU_SOLUTION = `class LRUCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be an integer >= 1");
    }
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  put(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

module.exports = { LRUCache };
`;

const LRU_CANONICAL_TEST = `const assert = require("node:assert");
const { LRUCache } = require("./lru.js");

assert.throws(() => new LRUCache(0), RangeError);

const c = new LRUCache(2);
c.put("a", 1);
c.put("b", 2);
c.put("a", 10); // update refreshes recency
c.put("c", 3); // must evict "b"
assert.strictEqual(c.get("a"), 10);
assert.strictEqual(c.get("b"), null);
console.log("lru tests passed");
`;

const ASYNC_FIX = `const { fetchScore } = require("./api.js");

async function main() {
  const ids = [1, 2, 3, 4];
  const total = (await Promise.all(ids.map((id) => fetchScore(id)))).reduce((a, b) => a + b, 0);
  console.log("DONE", total);
}

main();
`;

const BUG_CHAIN_FIXES: Array<[string, string]> = [
  [
    "money.js",
    `function roundMoney(x) {
  return Math.round(x * 100) / 100;
}

module.exports = { roundMoney };
`,
  ],
  [
    "cart.js",
    `const { roundMoney } = require("./money.js");

function parseDiscount(d) {
  if (typeof d === "string") {
    return parseFloat(d) / 100;
  }
  return d / 100;
}

function checkout(price, discount) {
  const frac = parseDiscount(discount);
  return roundMoney(price * (1 - frac));
}

module.exports = { parseDiscount, checkout };
`,
  ],
];

const PARALLEL_FILES: Array<[string, string]> = [
  [
    "roman.js",
    `function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError("1..3999");
  const table = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

module.exports = { toRoman };
`,
  ],
  [
    "tempconv.js",
    `function cToF(c) {
  return Number((c * 9 / 5 + 32).toFixed(1));
}

function fToC(f) {
  return Number(((f - 32) * 5 / 9).toFixed(1));
}

module.exports = { cToF, fToC };
`,
  ],
  [
    "words.js",
    `function initials(name) {
  const words = name.trim().split(/\\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return (first[0] ?? "").toUpperCase() + (last[0] ?? "").toUpperCase();
}

module.exports = { initials };
`,
  ],
];

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

  it("refactor-split: check rejects fixtures and accepts the full split", async () => {
    expect(await checkFails("refactor-split")).toBe(false);
    // Re-export added but logic NOT moved out must still fail.
    const reexportOnly = await checkPassesWith("refactor-split", (dir) =>
      writeFile(join(dir, "util.js"), `${REFACTOR_FILES[2][1]}\n${"function clamp() {}"}`),
    );
    expect(reexportOnly).toBe(false);
    const fullSplit = await checkPassesWith("refactor-split", async (dir) => {
      for (const [path, content] of REFACTOR_FILES) {
        await writeFile(join(dir, path), content);
      }
    });
    expect(fullSplit).toBe(true);
  });

  it("lru-cache-tdd: grader rejects stubs and broken eviction; tests must catch the broken impl", async () => {
    expect(await checkFails("lru-cache-tdd")).toBe(false);
    // Correct impl + tests that would NOT catch FIFO eviction must fail the swap.
    const weakTests = await checkPassesWith("lru-cache-tdd", async (dir) => {
      await writeFile(join(dir, "lru.js"), LRU_SOLUTION);
      await writeFile(
        join(dir, "lru.test.js"),
        `const assert = require("node:assert");\nconst { LRUCache } = require("./lru.js");\nconst c = new LRUCache(2);\nc.put("a", 1);\nc.put("b", 2);\nassert.strictEqual(c.get("a"), 1);\nconsole.log("weak");\n`,
      );
    });
    expect(weakTests).toBe(false);
    const strong = await checkPassesWith("lru-cache-tdd", async (dir) => {
      await writeFile(join(dir, "lru.js"), LRU_SOLUTION);
      await writeFile(join(dir, "lru.test.js"), LRU_CANONICAL_TEST);
    });
    expect(strong).toBe(true);
  });

  it("async-race: check rejects the buggy fixture and accepts the await fix", async () => {
    expect(await checkFails("async-race")).toBe(false);
    expect(
      await checkPassesWith("async-race", (dir) => writeFile(join(dir, "aggregate.js"), ASYNC_FIX)),
    ).toBe(true);
  });

  it("bug-chain: check rejects partial fixes and accepts both fixes", async () => {
    expect(await checkFails("bug-chain")).toBe(false);
    // Fix only parseDiscount (bug 1): rounding case still fails.
    const partial = await checkPassesWith("bug-chain", (dir) =>
      writeFile(join(dir, "cart.js"), BUG_CHAIN_FIXES[1][1]),
    );
    expect(partial).toBe(false);
    const both = await checkPassesWith("bug-chain", async (dir) => {
      for (const [path, content] of BUG_CHAIN_FIXES) {
        await writeFile(join(dir, path), content);
      }
    });
    expect(both).toBe(true);
  });

  it("parallel-modules: check rejects partial implementation and accepts all three modules", async () => {
    expect(await checkFails("parallel-modules")).toBe(false);
    // Two of three modules implemented must still fail.
    const partial = await checkPassesWith("parallel-modules", async (dir) => {
      for (const [path, content] of PARALLEL_FILES.slice(0, 2)) {
        await writeFile(join(dir, path), content);
      }
    });
    expect(partial).toBe(false);
    const full = await checkPassesWith("parallel-modules", async (dir) => {
      for (const [path, content] of PARALLEL_FILES) {
        await writeFile(join(dir, path), content);
      }
    });
    expect(full).toBe(true);
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

  it("runEvalTask passes a blind judge verdict into the result when configured", async () => {
    const task = findTask("bugfix-regression");
    if (!task) throw new Error("missing task");
    const solver = join(import.meta.dirname ?? ".", "fixture-pi-solve.sh");
    const judge = join(import.meta.dirname ?? ".", "fixture-pi-judge.sh");
    await writeFile(
      solver,
      `#!/bin/sh\nnode -e 'const fs=require("fs");let s=fs.readFileSync("stats.js","utf8");s=s.replace("i <= nums.length","i < nums.length");fs.writeFileSync("stats.js",s);'\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"fixed"}]}}'\n`,
    );
    const verdict = JSON.stringify({
      specAdherence: 8.5,
      codeQuality: 7,
      robustness: 9,
      overall: 8,
      notes: "clean fix",
    });
    const judgeEvent = `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Verdict: ${verdict}` }],
      },
    })}\n`;
    const judgeEventFile = `${judge}.event`;
    await writeFile(judgeEventFile, judgeEvent);
    await writeFile(judge, `#!/bin/sh\ncat "${judgeEventFile}"\n`);
    await chmod(solver, 0o755);
    await chmod(judge, 0o755);
    try {
      const result = await runEvalTask(task, {
        piBin: solver,
        model: "fixture/test",
        judge: { model: "judge/deepseek", piBin: judge },
      });
      expect(result.pass).toBe(true);
      expect(result.quality).toBeDefined();
      expect(result.quality?.overall).toBe(8);
      expect(result.quality?.specAdherence).toBe(8.5);
      expect(result.quality?.notes).toBe("clean fix");
    } finally {
      const fs = await import("node:fs/promises");
      await fs.rm(solver, { force: true });
      await fs.rm(judge, { force: true });
      await fs.rm(`${judge}.event`, { force: true });
    }
  });

  it("runEvalTask omits quality when the judge returns no parseable verdict", async () => {
    const task = findTask("bugfix-regression");
    if (!task) throw new Error("missing task");
    const solver = join(import.meta.dirname ?? ".", "fixture-pi-solve.sh");
    const judge = join(import.meta.dirname ?? ".", "fixture-pi-judge-bad.sh");
    await writeFile(
      solver,
      `#!/bin/sh\nnode -e 'const fs=require("fs");let s=fs.readFileSync("stats.js","utf8");s=s.replace("i <= nums.length","i < nums.length");fs.writeFileSync("stats.js",s);'\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"fixed"}]}}'\n`,
    );
    await writeFile(judge, `#!/bin/sh\necho 'I cannot grade this.'\n`);
    await chmod(solver, 0o755);
    await chmod(judge, 0o755);
    try {
      const result = await runEvalTask(task, {
        piBin: solver,
        model: "fixture/test",
        judge: { model: "judge/deepseek", piBin: judge },
      });
      expect(result.quality).toBeUndefined();
    } finally {
      const fs = await import("node:fs/promises");
      await fs.rm(solver, { force: true });
      await fs.rm(judge, { force: true });
    }
  });

  it("collectWorkspace bounds output and skips grader directories", async () => {
    const task = findTask("lru-cache-tdd");
    if (!task) throw new Error("missing task");
    const ws = await materializeTask(task);
    try {
      const text = await collectWorkspace(ws.dir);
      expect(text).toContain("=== lru.js ===");
      expect(text).toContain("=== SPEC.md ===");
      expect(text.includes("Known-broken reference")).toBe(false);
    } finally {
      await ws.cleanup();
    }
  });

  it("parseJudgeVerdict clamps and rejects malformed verdicts", () => {
    const good = parseJudgeVerdict(
      'blurb {"specAdherence":11,"codeQuality":-1,"robustness":7,"overall":8,"notes":"x"} tail',
    );
    expect(good?.specAdherence).toBe(10);
    expect(good?.codeQuality).toBe(0);
    expect(good?.overall).toBe(8);
    expect(parseJudgeVerdict("no json here")).toBeUndefined();
    expect(parseJudgeVerdict('{"specAdherence":"high"}')).toBeUndefined();
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
