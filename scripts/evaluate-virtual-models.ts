/** Opt-in sequential pilot. Default is four unscored smoke cases, never a scored matrix. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  MODEL_POOL,
  POLICY_VERSION,
  subscriptionExhausted,
} from "../extensions/virtual-models/src/policy.ts";
import { excludeFromGit, runGit } from "../lib/git.ts";
import { writeJsonAtomic } from "../lib/json-atomic.ts";
import { projectStateDir, projectStateRelative } from "../lib/paths.ts";
import { trackedSources } from "./codemode-evaluation/runtime.ts";
import { collectBaseline } from "./virtual-models-eval/baseline.ts";
import { object, sumUsage } from "./virtual-models-eval/ledger.ts";
import {
  type Case,
  parseOptions,
  planCases,
  workerParentPrompt,
} from "./virtual-models-eval/plan.ts";
import {
  capture,
  checkTaskWorkspace,
  createEvaluationWorkspace,
  harvest,
  recoverCase,
  recoverWorkspace,
  resetState,
  setupFiles,
} from "./virtual-models-eval/runtime.ts";
import { ExperimentStore } from "./virtual-models-eval/store.ts";
import {
  checkAnswer,
  DIAGNOSIS_PATH,
  FIXTURE_VERSION,
  taskSetup,
} from "./virtual-models-eval/tasks.ts";

const TASK_COMMIT = "cc936d4";
const execute = promisify(execFile);
async function configurationHashes(agentDir: string) {
  const hashes: Record<string, string | null> = {};
  const files = new Set([
    "settings.json",
    "models.json",
    "auth.json",
    "worker-model.json",
    "worker-extensions.json",
    "small-model.json",
    ...(await readdir(agentDir)).filter(
      (name) => name.endsWith(".json") && name !== "models-store.json",
    ),
  ]);
  for (const name of [...files].sort()) {
    try {
      hashes[name] = createHash("sha256")
        .update(await readFile(join(agentDir, name)))
        .digest("hex");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") hashes[name] = null;
      else throw error;
    }
  }
  return hashes;
}
async function fingerprint(repository: string, version: string) {
  const paths = (
    await runGit(repository, [
      "ls-files",
      "-z",
      "--",
      "extensions",
      "lib",
      "scripts",
      "types",
      "package-lock.json",
    ])
  )
    .split("\0")
    .filter((path) => /\.[cm]?[jt]s$/.test(path) || path === "package-lock.json")
    .sort();
  const hash = createHash("sha256").update(
    `${TASK_COMMIT}/${POLICY_VERSION}/${FIXTURE_VERSION}/${version}/${process.version}`,
  );
  for (const path of paths) hash.update(path).update(await readFile(join(repository, path)));
  return hash.digest("hex");
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function selectCases(cases: Case[], options: ReturnType<typeof parseOptions>): Case[] {
  return cases.filter(
    (item) =>
      options.tasks.includes(item.task) &&
      options.arms.includes(item.arm) &&
      options.roles.includes(item.role) &&
      options.repetitions.includes(item.repetition),
  );
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Live model calls. Default: unscored smoke. Options: --phase smoke|scored --tasks boundaries,diagnosis,fix,rename,review,schedule --arms sol,deepseek,glm,rules,jev --roles main,worker --repetitions 1 --output-dir PATH --resume PATH",
    );
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const repository = resolve(import.meta.dirname, "..");
  const status = (await runGit(repository, ["status", "--porcelain"])).trim();
  if (status)
    throw new Error("Commit the experiment code before live calls; worktree must be clean");
  const toolCommit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  const taskCommit = (await runGit(repository, ["rev-parse", `${TASK_COMMIT}^{commit}`])).trim();
  const { stdout } = await execute("pi", ["--version"]);
  const version = stdout.trim();
  const currentFingerprint = await fingerprint(repository, version);
  const sourceAgentDir = getAgentDir();
  const configurations = await configurationHashes(sourceAgentDir);
  const outputDirectory = resolve(
    options.resume ??
      options.outputDir ??
      join(
        projectStateDir(repository, "virtual-models-eval"),
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
  await excludeFromGit(repository, `${projectStateRelative("virtual-models-eval")}/`);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const baseline = await collectBaseline({
    agentDir: sourceAgentDir,
    env: process.env,
    async getAvailable() {
      const runtime = await ModelRuntime.create();
      return [
        ...(await runtime.getAvailableOfType("chat")),
        ...(await runtime.getAvailableOfType("classifier")),
      ];
    },
  });
  const store = options.resume
    ? await ExperimentStore.resume(outputDirectory, currentFingerprint, configurations)
    : await ExperimentStore.create(outputDirectory, {
        fingerprint: currentFingerprint,
        configurations,
        cases: planCases(options),
        phase: options.phase,
        piVersion: version,
        nodeVersion: process.version,
        toolCommit,
        taskCommit,
        policyVersion: POLICY_VERSION,
        fixtureVersion: FIXTURE_VERSION,
        baseline,
        tokenFormula:
          "input + output + cacheRead + cacheWrite; provider totals recorded separately; missing usage is unknown",
        toolConfiguration:
          "direct tools; codemode inactive for all arms; normal installed resources redirected to controller checkout; worker allowlist retains defaults and mandatory safety extensions",
        order: "role, task, repetition, arms rotated by task and repetition; sequential",
        catalog: "private copied catalog; startup model refresh disabled with PI_OFFLINE=1",
      });
  console.log(`Experiment: ${outputDirectory}`);
  for (const attempt of store.attempts.filter((entry) => entry.status === "interrupted")) {
    const prefix = join(outputDirectory, attempt.id);
    await recoverCase(prefix);
    await recoverWorkspace(prefix, repository);
  }
  if (baseline.missingModels.length || !baseline.configurationUnchanged)
    throw new Error("Preflight unavailable models or changed configuration; no inference started");
  const cases = store.pending(selectCases(store.manifest.cases, options));
  const workspace = await createEvaluationWorkspace(repository, taskCommit);
  const loadouts = new Map<string, string>();
  for (const attempt of store.attempts)
    if (Array.isArray(attempt.routes))
      for (const entry of attempt.routes.map(object).filter((entry) => entry.type === "loadout"))
        loadouts.set(
          `${object(attempt.case).task}/${entry.role}`,
          JSON.stringify([entry.activeTools, entry.tools]),
        );
  let paused = false;
  let configurationUnchanged = true;
  try {
    const sources = await trackedSources(workspace.cwd);
    for (const item of cases) {
      if (!same(configurations, await configurationHashes(sourceAgentDir)))
        throw new Error("Original configuration changed before a case; experiment paused");
      await resetState(workspace.cwd);
      await workspace.reset("on", "inventory");
      await setupFiles(workspace.cwd, taskSetup(item.task, sources));
      const attempt = await store.start(item);
      const prefix = join(outputDirectory, attempt.id);
      await writeJsonAtomic(
        `${prefix}.setup.json`,
        {
          case: item,
          toolCommit,
          taskCommit,
          fingerprint: currentFingerprint,
          cwd: workspace.cwd,
          agentDir: workspace.agentDir,
          startedAt: attempt.startedAt,
        },
        { mode: 0o600 },
      );
      console.log(`Running ${attempt.id}`);
      let finalized = false;
      try {
        const run = await capture({
          cwd: workspace.cwd,
          agentDir: workspace.agentDir,
          model: item.parentModel,
          workerModel: item.workerModel,
          prompt: item.role === "worker" ? workerParentPrompt(item) : item.prompt,
          prefix,
          timeoutMs: item.timeoutMs,
        });
        const children = await harvest(workspace.cwd, prefix);
        let infrastructure: string | undefined;
        if (
          run.quota ||
          children.workers.some((worker) => worker.errors.some(subscriptionExhausted))
        )
          infrastructure = "Chat subscription or quota exhausted; no substitute allowed";
        else if (run.interrupted) infrastructure = "Controller or case process interrupted";
        else if (run.error) infrastructure = run.error;
        else if (!run.timedOut && (run.exitCode !== 0 || !run.main.settled || run.main.aborted))
          infrastructure = `Incomplete process: exit=${run.exitCode}, settled=${run.main.settled}, aborted=${run.main.aborted}`;
        else if (
          !run.timedOut &&
          (run.main.stopReason === "error" ||
            children.workers.some((worker) => worker.stopReason === "error"))
        )
          infrastructure =
            "Provider request failed after retries; attempt is an infrastructure interruption";
        const allowedMainModels = item.parentModel.startsWith("virtual-models/")
          ? Object.values(MODEL_POOL)
          : [item.parentModel];
        const allowedWorkerModels = item.workerModel.startsWith("virtual-models/")
          ? Object.values(MODEL_POOL)
          : [item.workerModel];
        if (
          run.main.models.some(
            (model) => !allowedMainModels.some((allowed) => allowed === model),
          ) ||
          children.workers.some((worker) =>
            worker.models.some(
              (model) => !allowedWorkerModels.some((allowed) => allowed === model),
            ),
          )
        )
          infrastructure ??= "Unexpected physical dispatch outside the comparison arm";
        if (children.records.some((record) => record.model !== item.workerModel))
          infrastructure ??= "Unexpected worker selection; paired comparison invalid";
        if (item.role === "worker" && children.records.length !== 1)
          infrastructure ??= "Expected exactly one real delegated worker";
        if (item.role === "worker") {
          if (run.main.tools.some((name) => name !== "spawn_worker" && name !== "workers"))
            infrastructure ??= "Parent used task tools; worker-only comparison invalid";
          const assignmentMatches = children.records.every(
            (record) => record.task === item.assignment,
          );
          if (!assignmentMatches) infrastructure ??= "Parent changed the fixed worker assignment";
        }
        for (const entry of children.routes.filter((entry) => entry.type === "loadout")) {
          const expectedSelection = entry.role === "main" ? item.parentModel : item.workerModel;
          if (entry.selected !== expectedSelection)
            infrastructure ??= "Selected identity differs from the comparison arm";
          const key = `${item.task}/${entry.role}`;
          const signature = JSON.stringify([entry.activeTools, entry.tools]);
          const previous = loadouts.get(key);
          if (previous && previous !== signature)
            infrastructure ??= "Effective tool loadout changed across arms";
          loadouts.set(key, signature);
        }
        if (!children.routes.some((entry) => entry.type === "loadout" && entry.role === "main"))
          infrastructure ??= "Missing main tool-loadout evidence";
        if (
          children.records.length &&
          !children.routes.some((entry) => entry.type === "loadout" && entry.role === "worker")
        )
          infrastructure ??= "Missing worker tool-loadout evidence";
        const patch = await checkTaskWorkspace(
          workspace.cwd,
          item.task,
          sources,
          join(repository, "node_modules"),
          `${prefix}.independent-tests.json`,
        );
        const commands = [
          ...run.main.commands,
          ...children.workers.flatMap((worker) => worker.commands),
        ];
        const answerText =
          item.role === "worker" ? (children.workers[0]?.finalText ?? "") : run.main.finalText;
        const checked = checkAnswer(item.task, answerText, {
          patchPassed: patch.passed,
          diagnosisExecuted: commands.some(
            (command) => command.includes("vitest") && command.includes(DIAGNOSIS_PATH),
          ),
        });
        const workerCompleted =
          item.role !== "worker" ||
          children.records.every((record) => record.status === "completed");
        const taskConstraints =
          item.role !== "main" ||
          (item.task === "boundaries"
            ? children.records.length === 1
            : children.records.length === 0);
        const passed =
          taskConstraints &&
          workerCompleted &&
          !infrastructure &&
          !run.timedOut &&
          run.main.stopReason === "stop" &&
          patch.passed &&
          checked.passed;
        const reason =
          infrastructure ??
          (!taskConstraints
            ? "Delegation constraint violated"
            : !workerCompleted
              ? "Worker did not complete"
              : run.timedOut
                ? "Task time limit exceeded"
                : !patch.passed
                  ? "Independent worktree check failed"
                  : checked.reason);
        const totalUsage = sumUsage([
          run.main.usage,
          children.workerUsage,
          children.classifierUsage,
        ]);
        await store.finish(attempt.id, {
          status: infrastructure ? "interrupted" : "completed",
          passed,
          reason,
          case: item,
          ...run,
          ...children,
          patchCheck: patch,
          totalUsage,
          routerSwitches: children.routes.filter(
            (route) => route.type === "route" && route.switched === true,
          ).length,
        });
        finalized = true;
        console.log(
          `${infrastructure ? "PAUSED" : passed ? "PASS" : "FAIL"} ${attempt.id}: ${reason}; ${(run.wallMs / 1000).toFixed(2)}s; ${totalUsage.aggregate ?? "unknown"} tokens`,
        );
        await writeJsonAtomic(
          join(outputDirectory, "summary.json"),
          {
            phase: store.manifest.phase,
            attempts: store.attempts,
            completed: store.attempts.filter((attempt) => attempt.status === "completed").length,
            interrupted: store.attempts.filter((attempt) => attempt.status === "interrupted")
              .length,
          },
          { mode: 0o600 },
        );
        if (infrastructure || (store.manifest.phase === "smoke" && !passed)) {
          paused = true;
          break;
        }
      } catch (error) {
        if (!finalized)
          await store.finish(attempt.id, {
            status: "interrupted",
            passed: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        paused = true;
        throw error;
      }
    }
  } finally {
    configurationUnchanged = same(configurations, await configurationHashes(sourceAgentDir));
    await writeJsonAtomic(
      join(outputDirectory, "batch.json"),
      {
        endedAt: new Date().toISOString(),
        paused,
        originalConfigurationUnchanged: configurationUnchanged,
        remaining: store.pending(store.manifest.cases).map((item) => item.id),
      },
      { mode: 0o600 },
    );
    await workspace.dispose();
    if (!configurationUnchanged) console.error("Original configuration changed; experiment paused");
  }
  if (!configurationUnchanged) throw new Error("Original configuration changed; experiment paused");
  if (paused) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
