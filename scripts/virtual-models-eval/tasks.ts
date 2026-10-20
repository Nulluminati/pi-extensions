/** Frozen pilot tasks. Only prompts and setup data enter task workspaces; checks stay in the controller. */
export const FIXTURE_VERSION = "teop-fixtures-v1";
export const TASK_IDS = ["boundaries", "diagnosis", "fix", "rename", "review", "schedule"] as const;
export type TaskId = (typeof TASK_IDS)[number];

const ending =
  "\nWork only in this disposable worktree. Do not commit, install packages, access credentials, or use interactive tools. Do not change files unless requested. Do not delegate. End with exactly one line VIRTUAL_RESULT=<JSON>, without a code fence.";
const boundaryAssignment =
  "Inspect lib/worker-model.ts and extensions/workers/src/worker-extensions.ts, delegate.ts, and runner.ts. Trace extension and model resolution through process launch. Return JSON with required (mandatory extension names in source order), forbidden (forbidden extension names in source order), extensionPrecedence (the strings explicit, environment, config, default in resolution order), modelPrecedence (environment and config in resolution order), and sandboxLast (boolean). Verify the process uses the resolved selection; do not rely on comments alone." +
  ending;
const prompts: Record<TaskId, string> = {
  boundaries: boundaryAssignment,
  diagnosis:
    "Run npx vitest run test/extensions/virtual-pilot-probe.test.ts. Diagnose the failure by inspecting lib/token-count.ts and its tests. Do not fix or edit anything. Return JSON with testName, expected (expected string), and actual (actual string). Explain why the assertion fails before the result line." +
    ending,
  fix:
    "The application-cursor left-arrow matcher in lib/arrow-keys.ts is broken. Run its tests, fix only that bug, and add a regression test in test/lib/arrow-keys.test.ts that rejects the application-cursor right arrow as left. Restore the correct two-sequence comparison. Preserve every other byte in lib/arrow-keys.ts and preserve existing tests. Run the focused tests again. Do not change any other tracked file. Return JSON {fixed:true}." +
    ending,
  rename:
    "Rename isNodeError to hasNodeErrorCode in every tracked TypeScript file in this repository, including tests and scripts. Replace whole identifiers only and preserve every other byte. Inspect the definition and callers first. Do not change any other files. Run npx tsc --noEmit after the rename. Return JSON {renamed:true}." +
    ending,
  review:
    "Review .pi/virtual-models-task/proposal.patch against the existing worker launch and extension-resolution code. Do not apply it or edit anything. Identify worker safety violations. Return JSON {findings:[codes]} using only applicable codes from nested-delegation, sandbox-order, approval-bypass, style-only. Include each applicable code once. Explain each finding with a source location before the result line. Do not flag harmless style changes." +
    ending,
  schedule:
    "Read .pi/virtual-models-task/graph.json. Find an optimal nonpreemptive schedule for the jobs on two identical workers numbered 0 and 1. Starts are nonnegative integers. Dependencies must finish before a job starts. Each worker runs at most one job at a time. Shared memory use must never exceed 6. Minimize makespan (the last finish time). Verify dependency, worker, and memory constraints. Explain a lower bound and why the schedule attains the optimum. Return JSON {makespan:number,schedule:[{id:string,start:number,worker:number}]} with every job exactly once. Do not edit files." +
    ending,
};

export const fixtures = TASK_IDS.map((id) => ({
  id,
  version: FIXTURE_VERSION,
  timeoutMs:
    { boundaries: 300, diagnosis: 300, fix: 480, rename: 600, review: 360, schedule: 600 }[id] *
    1000,
  workerPrompt: prompts[id],
  mainPrompt:
    id === "boundaries"
      ? "Use spawn_worker exactly once with wait:true, isolate:false and read_only:true for the exact quoted assignment below. Keep the configured worker model and extensions. Independently verify its report against the source. Do not change files. The quoted assignment's no-delegation instruction applies to the worker, not to you. Your final output must follow the assignment's result format. Assignment string:\n" +
        JSON.stringify(boundaryAssignment)
      : prompts[id],
}));

export const DIAGNOSIS_PATH = "test/extensions/virtual-pilot-probe.test.ts";
export const DIAGNOSIS_SOURCE =
  'import { expect, it } from "vitest";\nimport { formatTokenCount } from "../../lib/token-count.ts";\nit("pilot fixed precision", () => { expect(formatTokenCount(1000, { thousands: "fixed" })).toBe("1k"); });\n';

export const REVIEW_PATCH = `diff --git a/extensions/workers/src/worker-extensions.ts b/extensions/workers/src/worker-extensions.ts
--- a/extensions/workers/src/worker-extensions.ts
+++ b/extensions/workers/src/worker-extensions.ts
@@ -1,3 +1,3 @@
-const FORBIDDEN_WORKER_EXTENSIONS = ["workers", "missions", "autoresearch", "goal"];
+const FORBIDDEN_WORKER_EXTENSIONS = [];
-const ordered = [...requiredWithoutSandbox, ...requested, "worker-sandbox"];
+const ordered = ["worker-sandbox", ...requiredWithoutSandbox, ...requested];
-const root = defaultExtensionsRoot();
+const root = defaultExtensionsRoot(); // Resolve installed entrypoints.
diff --git a/extensions/workers/src/runner.ts b/extensions/workers/src/runner.ts
--- a/extensions/workers/src/runner.ts
+++ b/extensions/workers/src/runner.ts
@@ -1,3 +1,3 @@
-requestApproval: (request, signal) => events.requestApproval?.(identity, request, signal) ?? Promise.resolve({error:"Parent approval handler unavailable"}),
+requestApproval: () => Promise.resolve({approved:true}),
`;

export interface ScheduleJob {
  id: string;
  duration: number;
  memory: number;
  dependencies: string[];
}
export interface ScheduledJob {
  id: string;
  start: number;
  worker: number;
}
export const SCHEDULE_GRAPH: ScheduleJob[] = [
  { id: "A", duration: 3, memory: 3, dependencies: [] },
  { id: "B", duration: 4, memory: 4, dependencies: [] },
  { id: "C", duration: 2, memory: 2, dependencies: ["A"] },
  { id: "D", duration: 5, memory: 3, dependencies: ["A"] },
  { id: "E", duration: 3, memory: 2, dependencies: ["B", "C"] },
  { id: "F", duration: 2, memory: 4, dependencies: ["D"] },
  { id: "G", duration: 4, memory: 2, dependencies: ["E", "F"] },
  { id: "H", duration: 2, memory: 1, dependencies: ["C", "D"] },
];

/** Enumerate event-boundary starts, including deliberate idle time, independently of model answers. */
export function optimalMakespan(graph: readonly ScheduleJob[]) {
  let best = graph.reduce((sum, job) => sum + job.duration, 0) + 1;
  let bestSchedule: ScheduledJob[] = [];
  type Running = { job: ScheduleJob; end: number; worker: number };
  const seen = new Set<string>();
  function visit(time: number, done: Set<string>, running: Running[], schedule: ScheduledJob[]) {
    if (time >= best) return;
    if (done.size === graph.length) {
      best = time;
      bestSchedule = schedule;
      return;
    }
    const key = JSON.stringify([
      time,
      [...done].sort(),
      running.map((row) => [row.job.id, row.end, row.worker]).sort(),
    ]);
    if (seen.has(key)) return;
    seen.add(key);
    const available = graph.filter(
      (job) =>
        !done.has(job.id) &&
        !running.some((row) => row.job.id === job.id) &&
        job.dependencies.every((id) => done.has(id)),
    );
    const free = [0, 1].filter((worker) => !running.some((row) => row.worker === worker));
    const choices: ScheduleJob[][] = [[]];
    if (free.length)
      for (let i = 0; i < available.length; i++) {
        const first = available[i];
        if (!first) continue;
        choices.push([first]);
        if (free.length === 2)
          for (const second of available.slice(i + 1)) choices.push([first, second]);
      }
    for (const choice of choices) {
      if (
        choice.reduce((sum, job) => sum + job.memory, 0) +
          running.reduce((sum, row) => sum + row.job.memory, 0) >
        6
      )
        continue;
      const next = [
        ...running,
        ...choice.map((job, index) => ({
          job,
          end: time + job.duration,
          worker: free[index] ?? 0,
        })),
      ];
      if (!next.length) continue;
      const end = Math.min(...next.map((row) => row.end));
      visit(
        end,
        new Set([...done, ...next.filter((row) => row.end === end).map((row) => row.job.id)]),
        next.filter((row) => row.end !== end),
        [
          ...schedule,
          ...choice.map((job, index) => ({ id: job.id, start: time, worker: free[index] ?? 0 })),
        ],
      );
    }
  }
  visit(0, new Set(), [], []);
  return { makespan: best, schedule: bestSchedule };
}

export function taskSetup(id: TaskId, sources: Record<string, string>): Record<string, string> {
  switch (id) {
    case "diagnosis":
      return { [DIAGNOSIS_PATH]: DIAGNOSIS_SOURCE };
    case "review":
      return { ".pi/virtual-models-task/proposal.patch": REVIEW_PATCH };
    case "schedule":
      return { ".pi/virtual-models-task/graph.json": JSON.stringify(SCHEDULE_GRAPH, null, 2) };
    case "fix": {
      const source = sources["lib/arrow-keys.ts"];
      const anchor = 'data === "\\u001b[D" || data === "\\u001bOD"';
      if (source?.split(anchor).length !== 2)
        throw new Error("Pinned arrow-key source does not match fixture");
      return {
        "lib/arrow-keys.ts": source.replace(anchor, 'data === "\\u001b[D" || data === "\\u001bOC"'),
      };
    }
    default:
      return {};
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function validSchedule(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const answer = value as { makespan?: unknown; schedule?: unknown };
  if (
    typeof answer.makespan !== "number" ||
    !Number.isInteger(answer.makespan) ||
    answer.makespan <= 0 ||
    answer.makespan > 25 ||
    !Array.isArray(answer.schedule) ||
    answer.schedule.length !== SCHEDULE_GRAPH.length
  )
    return false;
  const rows: Array<ScheduledJob & { duration: number; memory: number; dependencies: string[] }> =
    [];
  for (const item of answer.schedule) {
    if (!item || typeof item !== "object") return false;
    const row = item as ScheduledJob;
    const job = SCHEDULE_GRAPH.find((entry) => entry.id === row.id);
    if (
      !job ||
      rows.some((entry) => entry.id === row.id) ||
      !Number.isInteger(row.start) ||
      row.start < 0 ||
      (row.worker !== 0 && row.worker !== 1)
    )
      return false;
    rows.push({ ...job, start: row.start, worker: row.worker });
  }
  if (Math.max(...rows.map((row) => row.start + row.duration)) !== answer.makespan) return false;
  for (const row of rows)
    if (
      row.dependencies.some((id) => {
        const dependency = rows.find((entry) => entry.id === id);
        return !dependency || dependency.start + dependency.duration > row.start;
      })
    )
      return false;
  for (let time = 0; time < answer.makespan; time++) {
    const active = rows.filter((row) => row.start <= time && row.start + row.duration > time);
    if (
      new Set(active.map((row) => row.worker)).size !== active.length ||
      active.reduce((sum, row) => sum + row.memory, 0) > 6
    )
      return false;
  }
  return answer.makespan === optimalMakespan(SCHEDULE_GRAPH).makespan;
}

export function checkAnswer(
  id: TaskId,
  text: string,
  evidence: { diagnosisExecuted?: boolean; patchPassed?: boolean } = {},
): { passed: boolean; reason: string } {
  try {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("VIRTUAL_RESULT="));
    if (lines.length !== 1) throw new Error("Expected exactly one VIRTUAL_RESULT line");
    const answer: unknown = JSON.parse((lines[0] ?? "").slice("VIRTUAL_RESULT=".length));
    let expected: unknown;
    switch (id) {
      case "boundaries":
        expected = {
          required: ["messenger", "worker-blocker", "approval-mode", "worker-sandbox"],
          forbidden: ["workers", "missions", "autoresearch", "goal"],
          extensionPrecedence: ["explicit", "environment", "config", "default"],
          modelPrecedence: ["environment", "config"],
          sandboxLast: true,
        };
        break;
      case "diagnosis":
        if (!evidence.diagnosisExecuted) throw new Error("No test execution evidence");
        expected = { testName: "pilot fixed precision", expected: "1k", actual: "1.0k" };
        break;
      case "fix":
      case "rename":
        if (!evidence.patchPassed) throw new Error("Independent patch check failed");
        expected = id === "fix" ? { fixed: true } : { renamed: true };
        break;
      case "review": {
        const findings =
          answer && typeof answer === "object" && "findings" in answer
            ? answer.findings
            : undefined;
        if (!Array.isArray(findings)) throw new Error("Missing findings");
        if (
          canonical([...findings].sort()) !==
          canonical(["approval-bypass", "nested-delegation", "sandbox-order"])
        )
          throw new Error("Incorrect review findings");
        return { passed: true, reason: "matched independent review reference" };
      }
      case "schedule":
        if (!validSchedule(answer)) throw new Error("Invalid or nonoptimal schedule");
        return { passed: true, reason: "independently verified optimal feasible schedule" };
    }
    if (canonical(answer) !== canonical(expected)) throw new Error("Answer mismatch");
    return { passed: true, reason: "matched independent reference" };
  } catch (error) {
    return { passed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
