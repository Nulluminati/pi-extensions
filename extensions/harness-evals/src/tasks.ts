/**
 * Built-in evaluation tasks. Each probes a failure surface observed in real
 * agent work; checks are deterministic shell commands graded in the task
 * directory. Prompts are deliberately realistic (no hints about the check).
 */

import type { EvalTask } from "./types.ts";

// --- Constants ---

const TEN_MINUTES = 600_000;

// --- Tasks ---

export const BUILT_IN_TASKS: EvalTask[] = [
  {
    id: "bugfix-regression",
    title: "Fix a failing test without touching the test",
    probes: "Root-cause debugging; respect for existing tests.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "Run `node stats.test.js` in this project. It fails.",
      "Fix the bug in stats.js so the test passes.",
      "Do not modify stats.test.js and do not weaken the assertion; fix the actual bug.",
    ].join(" "),
    fixtures: [
      {
        path: "stats.js",
        content: `// Averages an array of numbers.\nfunction average(nums) {\n  let total = 0;\n  for (let i = 0; i <= nums.length; i++) {\n    total += nums[i];\n  }\n  return total / nums.length;\n}\n\nmodule.exports = { average };\n`,
      },
      {
        path: "stats.test.js",
        content: `const assert = require("node:assert");\nconst { average } = require("./stats.js");\n\nassert.strictEqual(average([2, 4, 6]), 4, "average([2,4,6]) should be 4");\nassert.strictEqual(average([10]), 10, "single value averages to itself");\nconsole.log("all stats tests passed");\n`,
      },
    ],
    checks: {
      name: "stats tests pass and test file untouched",
      command: `node stats.test.js && test -z "$(git status --porcelain stats.test.js)" && echo CHECK-OK`,
    },
  },
  {
    id: "multi-file-rename",
    title: "Rename a function across dependent files",
    probes: "Cross-file consistency; finding all call sites.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "Rename the function fmtAmount to formatCurrency across this whole project.",
      "Every definition and every call site must use the new name.",
      "Behavior must stay identical: node main.js must print exactly the same output as before.",
    ].join(" "),
    fixtures: [
      {
        path: "format.js",
        content: `function fmtAmount(cents) {\n  return "$" + (cents / 100).toFixed(2);\n}\n\nmodule.exports = { fmtAmount };\n`,
      },
      {
        path: "invoice.js",
        content: `const { fmtAmount } = require("./format.js");\n\nfunction invoiceLine(label, cents) {\n  return label + ": " + fmtAmount(cents);\n}\n\nmodule.exports = { invoiceLine };\n`,
      },
      {
        path: "report.js",
        content: `const { fmtAmount } = require("./format.js");\n\nfunction totalLine(cents) {\n  return "TOTAL " + fmtAmount(cents);\n}\n\nmodule.exports = { totalLine };\n`,
      },
      {
        path: "main.js",
        content: `const { invoiceLine } = require("./invoice.js");\nconst { totalLine } = require("./report.js");\n\nconsole.log(invoiceLine("Widget", 1250));\nconsole.log(totalLine(1250));\n`,
      },
    ],
    checks: {
      name: "program works and no fmtAmount references remain",
      command: `node main.js | grep -qx 'Widget: \\$12.50' && node main.js | grep -qx 'TOTAL \\$12.50' && ! grep -rn "fmtAmount" --include='*.js' . && echo CHECK-OK`,
    },
  },
  {
    id: "misleading-diagnosis",
    title: "Fix the real bug behind a misleading test failure",
    probes: "Diagnosis depth; not trusting the failure message blindly.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "`node run.test.js` fails in this project. Diagnose the actual bug it reveals and fix it.",
      "Do not modify run.test.js.",
    ].join(" "),
    fixtures: [
      {
        path: "mathx.js",
        content: `function halve(n) {\n  return n / 2;\n}\n\nmodule.exports = { halve };\n`,
      },
      {
        path: "scale.js",
        content: `function double(n) {\n  return n * 3;\n}\n\nmodule.exports = { double };\n`,
      },
      {
        path: "run.test.js",
        content: `const assert = require("node:assert");\nconst { halve } = require("./mathx.js");\nconst { double } = require("./scale.js");\n\n// double(4) must be two halve-inverse steps: halve(4) * 4 === double(4).\nassert.strictEqual(double(4), halve(4) * 4, "double inconsistent with halve: got " + double(4) + ", halve says " + halve(4));\nconsole.log("scale tests passed");\n`,
      },
    ],
    checks: {
      name: "tests pass and double actually doubles",
      command: `node run.test.js && node -e 'const {double}=require("./scale.js"); if (double(5)!==10) { process.exit(1); }' && echo CHECK-OK`,
    },
  },
  {
    id: "implement-to-spec",
    title: "Implement slugify from a written spec",
    probes: "From-spec implementation; edge cases.",
    timeoutMs: TEN_MINUTES,
    prompt: "Implement the slugify function in slug.js exactly according to SPEC.md.",
    fixtures: [
      {
        path: "SPEC.md",
        content: `# slugify spec\n\nslugify(text) returns a URL slug:\n\n1. Trim leading and trailing whitespace.\n2. Lowercase everything.\n3. Replace every run of characters that are not a-z, 0-9, or whitespace with a single space.\n4. Collapse every run of whitespace into a single dash "-".\n5. Trim leading and trailing dashes.\n\nExamples:\n- slugify("  Hello, World!  ") === "hello-world"\n- slugify("A  B---C?? D") === "a-b-c-d"\n- slugify("  --Émigré--  ") === "migr"\n`,
      },
      {
        path: "slug.js",
        content: `// TODO: implement per SPEC.md\nfunction slugify(text) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { slugify };\n`,
      },
    ],
    checks: {
      name: "slugify matches the spec examples and edge cases",
      command: `node -e '\nconst { slugify } = require("./slug.js");\nconst cases = [\n  ["  Hello, World!  ", "hello-world"],\n  ["A  B---C?? D", "a-b-c-d"],\n  ["  --Emigre--  ", "emigre"],\n  ["NoSpaces", "nospaces"],\n  ["   ", ""],\n  ["Multiple   Internal    Spaces", "multiple-internal-spaces"],\n];\nfor (const [input, expected] of cases) {\n  const got = slugify(input);\n  if (got !== expected) {\n    console.error("slugify(" + JSON.stringify(input) + ") = " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));\n    process.exit(1);\n  }\n}\nconsole.log("CHECK-OK");\n'`,
    },
  },
  {
    id: "test-first-bugfix",
    title: "Write a regression test, then fix the bug",
    probes: "Test-writing discipline; regression protection.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "parse.js has a bug: numbers written with thousands separators, like '1,234',",
      "throw a not-a-number error instead of parsing as 1234.",
      "First add a failing regression test for this to parse.test.js, run it to see it fail,",
      "then fix parse.js so the test passes. The final state must have both the test and the fix.",
    ].join(" "),
    fixtures: [
      {
        path: "parse.js",
        content: `function parseCount(text) {\n  const n = Number(text);\n  if (Number.isNaN(n)) {\n    throw new Error("not a number: " + JSON.stringify(text));\n  }\n  return n;\n}\n\nmodule.exports = { parseCount };\n`,
      },
      {
        path: "parse.test.js",
        content: `const assert = require("node:assert");\nconst { parseCount } = require("./parse.js");\n\nassert.strictEqual(parseCount("7"), 7);\nconsole.log("basic parse tests passed");\n`,
      },
      {
        path: ".orig/parse.js",
        content: `function parseCount(text) {\n  const n = Number(text);\n  if (Number.isNaN(n)) {\n    throw new Error("not a number: " + JSON.stringify(text));\n  }\n  return n;\n}\n\nmodule.exports = { parseCount };\n`,
      },
    ],
    checks: {
      name: "tests pass in final state, and they catch the original bug",
      command: `node parse.test.js || exit 1\ncp parse.js .fixed-parse.js\ncp .orig/parse.js parse.js\nif node parse.test.js >/dev/null 2>&1; then\n  mv .fixed-parse.js parse.js\n  echo REGRESSION-TEST-DOES-NOT-CATCH-BUG\n  exit 1\nfi\nmv .fixed-parse.js parse.js\nnode parse.test.js && echo CHECK-OK`,
    },
  },
];

// --- Lookup ---

export function findTask(id: string): EvalTask | undefined {
  return BUILT_IN_TASKS.find((t) => t.id === id);
}
