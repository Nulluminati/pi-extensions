export const TOOL_NAMES: Record<string, string[]> = {
  "ask-user": ["ask_user"],
  autoresearch: ["autoresearch"],
  "background-jobs": ["background", "jobs", "monitor"],
  "code-search": ["code_search"],
  "codex-image": ["generate_image"],
  context7: [
    "context7_get_cached_doc_raw",
    "context7_get_library_docs",
    "context7_resolve_library_id",
  ],
  jev: ["jev"],
  messenger: ["messenger"],
  missions: ["mission"],
  todos: ["todo"],
  "web-search": ["web_fetch", "web_search"],
  "worker-blocker": ["report_blocker"],
  "worker-sandbox": ["bash", "edit", "find", "grep", "ls", "read", "write"],
  workers: ["spawn_worker", "workers"],
};

export const REGISTER_COUNTS: Record<string, number> = {
  "ask-user": 1,
  autoresearch: 1,
  "background-jobs": 3,
  "code-search": 1,
  "codex-image": 1,
  context7: 3,
  jev: 1,
  messenger: 1,
  missions: 1,
  todos: 1,
  "web-search": 2,
  "worker-blocker": 1,
  "worker-sandbox": 1,
  workers: 2,
};

export const TASK_IDS = [
  "inventory",
  "counts",
  "imports",
  "tests",
  "failure",
  "rename",
  "facts",
  "ui",
] as const;
export type TaskId = (typeof TASK_IDS)[number];

export const FAILURE_FIXTURE_PATH = "test/extensions/t5nb-probe.test.ts";
export const FAILURE_TEST_NAME = "codemode probe detects wrong product";
export const FAILURE_FIXTURE = `import { expect, it } from "vitest";\nit("${FAILURE_TEST_NAME}", () => { expect(2 * 3).toBe(7); });\n`;
export const HELPER_FROM = "isNodeError";
export const HELPER_TO = "hasNodeErrorCode";

export interface Expectations {
  inventory: Record<string, string[]>;
  counts: Record<string, number>;
  imports: string[];
  tests: { passCount: number };
  failure: { testName: string; cause: string };
  rename: { renamed: boolean };
  facts: Record<string, string>;
  ui: Record<string, number>;
}

/** Reference answers come from the pinned tree before any model can edit it. */
export function deriveExpectations(files: Record<string, string>, passCount: number): Expectations {
  const imports = new Set<string>();
  const facts: Record<string, string> = {};
  const ui: Record<string, number> = {};
  for (const [path, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const extension = /^extensions\/([^/]+)\//.exec(path)?.[1];
    if (!extension || !path.endsWith(".ts")) continue;
    if (/from\s+["'](?:\.\.\/)+lib\/errors\.ts["']/.test(source)) imports.add(extension);
    const count = source.split("ctx.ui.").length - 1;
    if (count) ui[extension] = (ui[extension] ?? 0) + count;
    if (TOOL_NAMES[extension] && path === `extensions/${extension}/${extension}.ts`) {
      const name = /export\s+default\s+async\s+function\s+(\w+)/.exec(source)?.[1];
      if (name) facts[extension] = name;
    }
  }
  return {
    inventory: TOOL_NAMES,
    counts: REGISTER_COUNTS,
    imports: [...imports].sort(),
    tests: { passCount },
    failure: { testName: FAILURE_TEST_NAME, cause: "expected 7, received 6" },
    rename: { renamed: true },
    facts,
    ui,
  };
}

export function validateReferenceCounts(
  files: Record<string, string>,
  expected: Pick<Expectations, "inventory" | "counts">,
): void {
  const actual: Record<string, number> = {};
  for (const [path, source] of Object.entries(files)) {
    const extension = /^extensions\/([^/]+)\/.+\.ts$/.exec(path)?.[1];
    if (!extension) continue;
    const count = source.match(/\bpi\.registerTool\s*\(/g)?.length ?? 0;
    if (count) actual[extension] = (actual[extension] ?? 0) + count;
  }
  if (
    canonical(actual) !== canonical(expected.counts) ||
    canonical(Object.keys(actual)) !== canonical(Object.keys(expected.inventory))
  ) {
    throw new Error("Fixed reference tool inventory/counts do not match the pinned source");
  }
}

export function parseAnswer(text: string): unknown {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const last = lines.filter((line) => line.startsWith("CODEMODE_RESULT=")).at(-1);
  if (!last) throw new Error("Missing CODEMODE_RESULT= answer line");
  return JSON.parse(last.slice("CODEMODE_RESULT=".length)) as unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export interface CheckEvidence {
  commands?: readonly string[];
  typecheckPassed?: boolean;
  renameExact?: boolean;
}

export interface CheckResult {
  passed: boolean;
  reason: string;
}

export function checkAnswer(
  task: TaskId,
  text: string,
  expected: Expectations,
  evidence: CheckEvidence = {},
): CheckResult {
  try {
    const answer = parseAnswer(text);
    if (canonical(answer) !== canonical(expected[task]))
      return { passed: false, reason: "answer mismatch" };
    if (
      task === "tests" &&
      !evidence.commands?.some(
        (command) =>
          command.includes("vitest") && command.includes("test/extensions/todos.test.ts"),
      )
    ) {
      return { passed: false, reason: "no todos test execution in tool events" };
    }
    if (task === "rename" && (!evidence.typecheckPassed || !evidence.renameExact)) {
      return { passed: false, reason: "rename patch or typecheck failed" };
    }
    return { passed: true, reason: "matched" };
  } catch (error) {
    return { passed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function taskPrompts(): Record<TaskId, string> {
  const ending =
    "\nDo not ask questions or use interactive tools. Do not delegate. Do not commit. Do not install packages. Work only in this worktree. End your final response with one line CODEMODE_RESULT=<JSON>, without a code fence. Do not change files unless this task explicitly requests an edit.";
  return {
    inventory:
      "Find every extension under extensions/ that registers a tool, including tools registered conditionally or in loops. Return a JSON object mapping extension directory names to arrays of registered tool names. Include worker-sandbox's actual seven overridden tool names, not the loop variable. Omit extensions with no tools." +
      ending,
    counts:
      "Count literal pi.registerTool( call sites in TypeScript source under each extension directory. Count a call inside a loop once, not once per iteration. Ignore README files. Return a JSON object mapping extension directory names to nonzero integer counts. Omit zero counts." +
      ending,
    imports:
      "Find which extensions import the named shared module lib/errors.ts in any TypeScript file under their directory. Return a JSON array of extension directory names, with no duplicates." +
      ending,
    tests:
      'Run npx vitest run test/extensions/todos.test.ts. Wait for its final output. Report the number of passed tests, not test files, as JSON {"passCount":<number>}. Do not infer the count from source alone.' +
      ending,
    failure:
      `Run npx vitest run ${FAILURE_FIXTURE_PATH}. Identify the failing test's full name and the arithmetic assertion's cause. Do not fix it. Return JSON {"testName":"<name>","cause":"expected <expected number>, received <actual number>"}.` +
      ending,
    rename:
      `Rename the exported helper ${HELPER_FROM} in lib/errors.ts to ${HELPER_TO}. Update every whole-word occurrence in tracked TypeScript files, including tests and comments. Make only this mechanical replacement; do not change formatting or other text. Run npx tsc --noEmit. Return JSON {"renamed":true} only after the edit passes the typecheck.` +
      ending,
    facts: `Read each of these ${Object.keys(TOOL_NAMES).length} extension entrypoints and report one fact per file: its named default-exported async factory function. Return a JSON object mapping extension directory names to function names. Files: ${Object.keys(
      TOOL_NAMES,
    )
      .map((name) => `extensions/${name}/${name}.ts`)
      .join(", ")}.${ending}`,
    ui:
      "For each extension directory, count occurrences of the literal string ctx.ui. in all tracked TypeScript files under that directory, including comments and multiple occurrences on one line. Return only a JSON object mapping extension directory names to nonzero integer occurrence counts. Do not return matching source lines. Omit zero counts." +
      ending,
  };
}
