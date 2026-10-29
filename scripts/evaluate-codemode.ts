/**
 * Live, opt-in codemode A/B evaluation. Runs real models with normal installed
 * resources and credentials. Costs money. Raw events and results stay gitignored.
 * Never changes user settings. Each task runs in a reset temporary git worktree.
 *
 * Run: node --import tsx scripts/evaluate-codemode.ts
 * Smoke: node --import tsx scripts/evaluate-codemode.ts --tasks inventory --models openai-codex/gpt-6.1-sol --runs 1
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runGit } from "../lib/git.ts";
import { writeJsonAtomic } from "../lib/json-atomic.ts";
import { projectStateDir } from "../lib/paths.ts";
import { aggregateRuns, type ScoredRun } from "./codemode-evaluation/metrics.ts";
import {
  captureRun,
  checkRename,
  createWorkspace,
  referenceTestCount,
  trackedSources,
} from "./codemode-evaluation/runtime.ts";
import {
  checkAnswer,
  deriveExpectations,
  TASK_IDS,
  type TaskId,
  taskPrompts,
  validateReferenceCounts,
} from "./codemode-evaluation/tasks.ts";

const BASELINE_COMMIT = "6ddf3dd4d84d625c606db09b383b2b652d7f91cb";
const ARMS = ["off", "on", "only"] as const;
const MODELS = ["openai-codex/gpt-6.1-sol", "opencode-go/glm-5.3"];
const execute = promisify(execFile);

export interface EvaluationOptions {
  tasks: TaskId[];
  arms: string[];
  models: string[];
  runs: number;
  commit: string;
  timeoutMs: number;
}

export function parseOptions(args: string[]): EvaluationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !["--tasks", "--arms", "--models", "--runs", "--commit", "--timeout-seconds"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error(`Invalid or duplicate option: ${key ?? "missing"}`);
    values.set(key, value);
  }
  const list = (key: string, defaults: readonly string[]) => {
    const selected = values.get(key)?.split(",") ?? [...defaults];
    if (selected.some((value) => !value) || new Set(selected).size !== selected.length)
      throw new Error(`Empty or duplicate value for ${key}`);
    return selected;
  };
  const tasks = list("--tasks", TASK_IDS);
  const arms = list("--arms", ARMS);
  for (const task of tasks)
    if (!(TASK_IDS as readonly string[]).includes(task)) throw new Error(`Unknown task: ${task}`);
  for (const arm of arms)
    if (!(ARMS as readonly string[]).includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  const runs = Number(values.get("--runs") ?? 3);
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 300);
  if (
    !Number.isSafeInteger(runs) ||
    runs < 1 ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1
  )
    throw new Error("runs and timeout-seconds must be positive integers");
  return {
    tasks: tasks as TaskId[],
    arms,
    models: list("--models", MODELS),
    runs,
    commit: values.get("--commit") ?? BASELINE_COMMIT,
    timeoutMs: timeoutSeconds * 1000,
  };
}

function printSummary(runs: ScoredRun[]) {
  for (const perTask of [false, true]) {
    console.log(perTask ? "\nPer task" : "\nPer model and arm");
    console.table(
      aggregateRuns(runs, perTask).map((row) => ({
        model: row.model,
        arm: row.arm,
        task: row.task,
        pass: `${row.passed}/${row.runs}`,
        "pass %": (row.passRate * 100).toFixed(1),
        "median tokens": row.medianTokens,
        "median cost USD": row.medianCost.toFixed(6),
        "median seconds": (row.medianWallMs / 1000).toFixed(2),
        "median top tools": row.medianToolCalls,
        "median nested tools": row.medianNestedCalls,
      })),
    );
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Live evaluation; costs money. Options: --tasks inventory,counts,imports,tests,failure,rename,facts,ui --arms off,on,only --models provider/id,... --runs 3 --commit SHA --timeout-seconds 300",
    );
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const repository = resolve(import.meta.dirname, "..");
  const commit = (await runGit(repository, ["rev-parse", `${options.commit}^{commit}`])).trim();
  const { stdout: version } = await execute("pi", ["--version"]);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = join(projectStateDir(repository, "codemode-eval"), timestamp);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(getAgentDir(), "settings.json");
  const settingsHash = async () =>
    createHash("sha256")
      .update(await readFile(settingsPath))
      .digest("hex");
  const originalSettingsHash = await settingsHash();
  const metadata = {
    startedAt: new Date().toISOString(),
    piVersion: version.trim(),
    ...options,
    commit,
    requestedCommit: options.commit,
    resolvedCommit: commit,
    originalSettingsHash,
    order: "task, model, repetition, arms rotated by repetition; sequential",
  };
  await writeJsonAtomic(join(outputDir, "metadata.json"), metadata);
  const workspace = await createWorkspace(repository, commit);
  const runs: ScoredRun[] = [];
  let completed = false;
  try {
    const sources = await trackedSources(workspace.cwd);
    const expected = deriveExpectations(sources, await referenceTestCount(workspace.cwd));
    validateReferenceCounts(sources, expected);
    if (Object.keys(expected.facts).length < 10)
      throw new Error("Pinned tree does not supply ten file facts");
    await writeJsonAtomic(join(outputDir, "expected.json"), expected);
    const prompts = taskPrompts();
    for (const task of options.tasks) {
      for (const model of options.models) {
        for (let repetition = 0; repetition < options.runs; repetition++) {
          // Each arm goes first once across three repetitions, reducing order/cache bias.
          const offset = repetition % options.arms.length;
          const arms = [...options.arms.slice(offset), ...options.arms.slice(0, offset)];
          for (const arm of arms) {
            await workspace.reset(arm, task);
            const id = `${String(runs.length + 1).padStart(3, "0")}-${task}-${arm}`;
            console.log(`Running ${id} ${model} repetition ${repetition + 1}/${options.runs}`);
            const result = await captureRun({
              cwd: workspace.cwd,
              agentDir: workspace.agentDir,
              model,
              arm,
              prompt: prompts[task],
              outputPrefix: join(outputDir, id),
              timeoutMs: options.timeoutMs,
            });
            const renameEvidence =
              task === "rename" && !result.error
                ? await checkRename(workspace.cwd, sources, join(repository, "node_modules"))
                : {};
            const check = result.error
              ? { passed: false, reason: result.error }
              : checkAnswer(task, result.metrics.finalText, expected, {
                  commands: result.metrics.commands,
                  ...renameEvidence,
                });
            const run = {
              id,
              model,
              arm,
              task,
              repetition: repetition + 1,
              commit,
              ...result,
              checkerEvidence: renameEvidence,
              ...check,
            };
            runs.push(run);
            await appendFile(join(outputDir, "runs.jsonl"), `${JSON.stringify(run)}\n`, {
              mode: 0o600,
            });
            console.log(
              `${check.passed ? "PASS" : "FAIL"} ${id}: ${check.reason}; ${(result.wallMs / 1000).toFixed(2)}s, ${result.metrics.totalTokens} tokens, $${result.metrics.cost.toFixed(6)}`,
            );
            if (result.error && !result.timedOut)
              throw new Error(
                `Stopped after infrastructure error in ${id}. Read ${outputDir}/${id}.stderr.log`,
              );
          }
        }
      }
    }
    completed = true;
  } finally {
    printSummary(runs);
    await writeJsonAtomic(join(outputDir, "summary.json"), {
      byArm: aggregateRuns(runs),
      byTask: aggregateRuns(runs, true),
    });
    const unchanged = originalSettingsHash === (await settingsHash());
    await writeJsonAtomic(join(outputDir, "metadata.json"), {
      ...metadata,
      completed,
      finishedAt: new Date().toISOString(),
      userSettingsUnchanged: unchanged,
    });
    await workspace.dispose();
    console.log(`Raw results: ${outputDir}`);
    if (!unchanged) {
      console.error("User settings changed during evaluation; inspect before another run");
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
