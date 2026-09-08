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

  // --- Advanced / longer tasks ---

  {
    id: "refactor-split",
    title: "Split a module into three without changing behavior",
    probes: "Structure change under test protection; import-graph consistency.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "Split util.js into three modules: math-basic.js (clamp, lerp, roundTo),",
      "stats.js (sum, mean, stddev), and util.js itself becomes a thin re-export",
      "layer so util.test.js passes unchanged. Do not modify util.test.js.",
      "All function behavior must stay identical.",
    ].join(" "),
    fixtures: [
      {
        path: "util.js",
        content: `function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n\nfunction lerp(a, b, t) {\n  return a + (b - a) * t;\n}\n\nfunction roundTo(n, places) {\n  const f = 10 ** places;\n  return Math.round(n * f) / f;\n}\n\nfunction sum(nums) {\n  return nums.reduce((a, b) => a + b, 0);\n}\n\nfunction mean(nums) {\n  return nums.length === 0 ? 0 : sum(nums) / nums.length;\n}\n\nfunction stddev(nums) {\n  if (nums.length === 0) return 0;\n  const m = mean(nums);\n  return Math.sqrt(mean(nums.map((x) => (x - m) ** 2)));\n}\n\nmodule.exports = { clamp, lerp, roundTo, sum, mean, stddev };\n`,
      },
      {
        path: "util.test.js",
        content: `const assert = require("node:assert");\nconst { clamp, lerp, roundTo, sum, mean, stddev } = require("./util.js");\n\nassert.strictEqual(clamp(5, 0, 3), 3);\nassert.strictEqual(clamp(-1, 0, 3), 0);\nassert.strictEqual(lerp(0, 10, 0.25), 2.5);\nassert.strictEqual(roundTo(3.14159, 2), 3.14);\nassert.strictEqual(sum([1, 2, 3]), 6);\nassert.strictEqual(mean([2, 4, 6]), 4);\nassert.ok(Math.abs(stddev([2, 4, 4, 4, 5, 5, 7, 9]) - 2) < 1e-9);\nconsole.log("util tests passed");\n`,
      },
    ],
    checks: {
      name: "tests pass via re-export, logic moved out, both modules exist",
      command: `node util.test.js && test -z "$(git status --porcelain util.test.js)" && test -f math-basic.js && test -f stats.js && ! grep -q "function stddev" util.js && ! grep -q "function clamp" util.js && echo CHECK-OK`,
    },
  },

  {
    id: "lru-cache-tdd",
    title: "Implement an LRU cache from a spec, with tests that catch a broken eviction",
    probes: "From-spec implementation with edge cases plus test-writing discipline.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "Implement the LRUCache class in lru.js exactly per SPEC.md.",
      "Also create lru.test.js with tests you write BEFORE finalizing the implementation.",
      "Your tests must cover eviction order, including the case where updating an",
      "existing key refreshes its recency.",
    ].join(" "),
    fixtures: [
      {
        path: "SPEC.md",
        content: `# LRUCache spec\n\nclass LRUCache { constructor(capacity) }\n\n- capacity must be an integer >= 1; otherwise throw RangeError.\n- get(key): return the value or null when absent. Counts as a use.\n- put(key, value): insert or update. Counts as a use. When size exceeds\n  capacity, evict the LEAST recently used entry (a get or put refreshes\n  recency; overwriting an existing key does not grow the size).\n`,
      },
      {
        path: "lru.js",
        content: `// TODO: implement per SPEC.md\nclass LRUCache {\n  constructor(capacity) {\n    throw new Error("not implemented");\n  }\n}\n\nmodule.exports = { LRUCache };
`,
      },
      {
        // Known-broken reference: FIFO eviction, ignores recency refresh.
        path: ".broken/lru.js",
        content: `class LRUCache {\n  constructor(capacity) {\n    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity");\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  get(key) {\n    return this.map.has(key) ? this.map.get(key) : null;\n  }\n  put(key, value) {\n    if (this.map.has(key)) {\n      this.map.set(key, value);\n      return;\n    }\n    if (this.map.size >= this.capacity) {\n      this.map.delete(this.map.keys().next().value);\n    }\n    this.map.set(key, value);\n  }\n}\n\nmodule.exports = { LRUCache };
`,
      },
      {
        path: ".grader/verify.js",
        content: `const assert = require("node:assert");\nconst { LRUCache } = require("../lru.js");\n\nassert.throws(() => new LRUCache(0), RangeError);\nassert.throws(() => new LRUCache(-2), RangeError);\nassert.throws(() => new LRUCache(1.5), RangeError);\n\nconst c = new LRUCache(1);\nc.put("a", 1);\nc.put("b", 2);\nassert.strictEqual(c.get("a"), null);\nassert.strictEqual(c.get("b"), 2);\n\nconst u = new LRUCache(2);\nu.put("a", 1);\nu.put("b", 2);\nu.put("a", 10); // refresh recency of "a"\nu.put("c", 3); // evicts "b", not "a"\nassert.strictEqual(u.get("a"), 10);\nassert.strictEqual(u.get("b"), null);\nassert.strictEqual(u.get("c"), 3);\n\nconst g = new LRUCache(2);\ng.put("a", 1);\ng.put("b", 2);\nassert.strictEqual(g.get("a"), 1); // get refreshes recency\ng.put("c", 3); // evicts "b"\nassert.strictEqual(g.get("a"), 1);\nassert.strictEqual(g.get("b"), null);\n\nconsole.log("CHECK-OK");\n`,
      },
    ],
    checks: {
      name: "grader edge cases pass, and the agent's own tests catch broken eviction",
      command: `node .grader/verify.js || exit 1\nnode lru.test.js || exit 1\ncp lru.js .lru-fixed.js\ncp .broken/lru.js lru.js\nif node lru.test.js >/dev/null 2>&1; then\n  mv .lru-fixed.js lru.js\n  echo TESTS-DO-NOT-CATCH-BROKEN-EVICTION\n  exit 1\nfi\nmv .lru-fixed.js lru.js\nnode lru.test.js && echo CHECK-OK`,
    },
  },

  {
    id: "async-race",
    title: "Fix an async aggregation that prints before completion",
    probes: "Async control flow; deterministic correctness.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "aggregate.js must print exactly one line: DONE 12. Right now the output is wrong.",
      "Fix the bug so the total is correct and deterministic on every run.",
      "Keep using the existing fetchScore from api.js; do not modify api.js.",
    ].join(" "),
    fixtures: [
      {
        path: "api.js",
        content: `const SCORES = { 1: 3, 2: 4, 3: 5, 4: 0 };\n\nfunction fetchScore(id) {\n  return new Promise((resolve) => {\n    setTimeout(() => resolve(SCORES[id]), 20);\n  });\n}\n\nmodule.exports = { fetchScore };\n`,
      },
      {
        path: "aggregate.js",
        content: `const { fetchScore } = require("./api.js");\n\nasync function main() {\n  const ids = [1, 2, 3, 4];\n  let total = 0;\n  ids.map(async (id) => {\n    total += await fetchScore(id);\n  });\n  console.log("DONE", total);\n}\n\nmain();\n`,
      },
    ],
    checks: {
      name: "prints DONE 12 on three consecutive runs; api.js untouched",
      command: `for i in 1 2 3; do node aggregate.js | grep -qx "DONE 12" || exit 1; done && test -z "$(git status --porcelain api.js)" && echo CHECK-OK`,
    },
  },

  {
    id: "bug-chain",
    title: "Fix two layered bugs in a checkout path",
    probes: "Layered diagnosis; numeric correctness at boundaries.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "cart.test.js has failing cases. Find every bug they reveal and fix all of them.",
      "Do not modify cart.test.js. Money values must be rounded to cents, half up.",
    ].join(" "),
    fixtures: [
      {
        path: "money.js",
        content: `// Rounds a money value to cents.\nfunction roundMoney(x) {\n  return Math.floor(x * 100) / 100;\n}\n\nmodule.exports = { roundMoney };\n`,
      },
      {
        path: "cart.js",
        content: `const { roundMoney } = require("./money.js");\n\n// Accepts a number 0-100 or a string like "25%"; returns a 0-1 fraction.\nfunction parseDiscount(d) {\n  if (typeof d === "string") {\n    return parseFloat(d) / 100;\n  }\n  return d;\n}\n\nfunction checkout(price, discount) {\n  const frac = parseDiscount(discount);\n  return roundMoney(price * (1 - frac));\n}\n\nmodule.exports = { parseDiscount, checkout };\n`,
      },
      {
        path: "cart.test.js",
        content: `const assert = require("node:assert");\nconst { checkout } = require("./cart.js");\n\nassert.strictEqual(checkout(100, "25%"), 75);\nassert.strictEqual(checkout(100, 25), 75);\nassert.strictEqual(checkout(4.25, "50%"), 2.13);\nconsole.log("cart tests passed");\n`,
      },
    ],
    checks: {
      name: "tests pass and rounding is half-up at the boundary",
      command: `node cart.test.js && node -e 'const {roundMoney}=require("./money.js"); if (roundMoney(2.125)!==2.13) process.exit(1);' && echo CHECK-OK`,
    },
  },

  {
    id: "parallel-modules",
    title: "Implement three independent modules and wire an integration index",
    probes: "Decomposition; benefit of delegation when available; integration correctness.",
    timeoutMs: TEN_MINUTES,
    prompt: [
      "Implement roman.js, tempconv.js, and words.js exactly per SPEC.md so that",
      "index.test.js passes. If your environment provides a delegate or workers tool,",
      "use it to parallelize the three modules; otherwise implement them directly.",
      "Do not modify index.js or index.test.js.",
    ].join(" "),
    fixtures: [
      {
        path: "SPEC.md",
        content: `# Module specs\n\n## roman.js\ntoRoman(n): 1..3999 inclusive, uppercase Roman numerals. Outside the range, throw RangeError.\n\n## tempconv.js\ncToF(c): Celsius to Fahrenheit, rounded to 1 decimal.\nfToC(f): Fahrenheit to Celsius, rounded to 1 decimal.\n\n## words.js\ninitials(name): first character of the first word and of the last word,\nuppercased, concatenated. Words split on whitespace; ignore extra spaces.\nA single word yields its first letter uppercased twice (e.g. "madonna" -> "MM").\n`,
      },
      {
        path: "roman.js",
        content: `// TODO: implement per SPEC.md\nfunction toRoman(n) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { toRoman };\n`,
      },
      {
        path: "tempconv.js",
        content: `// TODO: implement per SPEC.md\nfunction cToF(c) {\n  throw new Error("not implemented");\n}\n\nfunction fToC(f) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { cToF, fToC };\n`,
      },
      {
        path: "words.js",
        content: `// TODO: implement per SPEC.md\nfunction initials(name) {\n  throw new Error("not implemented");\n}\n\nmodule.exports = { initials };\n`,
      },
      {
        path: "index.js",
        content: `module.exports = {\n  roman: require("./roman.js").toRoman,\n  cToF: require("./tempconv.js").cToF,\n  fToC: require("./tempconv.js").fToC,\n  initials: require("./words.js").initials,\n};\n`,
      },
      {
        path: "index.test.js",
        content: `const assert = require("node:assert");\nconst { roman, cToF, fToC, initials } = require("./index.js");\n\nassert.strictEqual(roman(2024), "MMXXIV");\nassert.throws(() => roman(0), RangeError);\nassert.strictEqual(cToF(100), 212);\nassert.strictEqual(fToC(32), 0);\nassert.strictEqual(initials("Ada Lovelace"), "AL");\nconsole.log("index tests passed");\n`,
      },
      {
        path: ".grader/verify.js",
        content: `const assert = require("node:assert");\nconst { roman, cToF, fToC, initials } = require("../index.js");\n\nassert.strictEqual(roman(1), "I");\nassert.strictEqual(roman(3999), "MMMCMXCIX");\nassert.strictEqual(roman(944), "CMXLIV");\nassert.throws(() => roman(4000), RangeError);\nassert.throws(() => roman(-5), RangeError);\nassert.strictEqual(cToF(-40), -40);\nassert.strictEqual(cToF(36.6), 97.9);\nassert.strictEqual(fToC(98.6), 37);\nassert.strictEqual(initials("  grace   brewster hopper "), "GH");\nassert.strictEqual(initials("madonna"), "MM");\n\nconsole.log("CHECK-OK");\n`,
      },
    ],
    checks: {
      name: "index tests pass, grader edge cases pass, no stubs remain",
      command: `node index.test.js && node .grader/verify.js && ! grep -qi "not implemented" roman.js tempconv.js words.js && echo CHECK-OK`,
    },
  },
];

// --- Lookup ---

export function findTask(id: string): EvalTask | undefined {
  return BUILT_IN_TASKS.find((t) => t.id === id);
}
