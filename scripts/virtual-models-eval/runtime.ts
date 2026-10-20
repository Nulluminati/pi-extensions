import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { subscriptionExhausted } from "../../extensions/virtual-models/src/policy.ts";
import { isWorkerId } from "../../extensions/workers/src/ids.ts";
import { DEFAULT_WORKER_EXTENSIONS } from "../../extensions/workers/src/worker-extensions.ts";
import { removeWorktree } from "../../extensions/workers/src/worktree.ts";
import { cleanGitEnv, excludeFromGit, runGit } from "../../lib/git.ts";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";
import { projectStateDir, projectStateRelative } from "../../lib/paths.ts";
import { isProcessAlive } from "../../lib/presence-shards.ts";
import { processStartTime } from "../../lib/process-identity.ts";
import { checkRename, createWorkspace } from "../codemode-evaluation/runtime.ts";
import { classifierUsage, EventLedger, object, routeUsage, sumUsage } from "./ledger.ts";
import { type Case, requiresWorkerIsolation } from "./plan.ts";
import { DIAGNOSIS_PATH, type TaskId, taskSetup } from "./tasks.ts";

const execute = promisify(execFile);
async function names(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
export async function cleanupWorkerWorktrees(cwd: string) {
  for (const id of await names(projectStateDir(cwd, "worktrees")))
    if (isWorkerId(id)) await removeWorktree(cwd, id);
}
export async function createEvaluationWorkspace(repository: string, commit: string) {
  const workspace = await createWorkspace(repository, commit);
  try {
    const path = join(workspace.agentDir, "settings.json");
    const settings = object(JSON.parse(await readFile(path, "utf8")));
    settings.packages = (Array.isArray(settings.packages) ? settings.packages : []).map((entry) => {
      if (entry === workspace.cwd) return repository;
      const config = object(entry);
      return config.source === workspace.cwd ? { ...config, source: repository } : entry;
    });
    // Keep one direct-tool configuration across every model and role. Worker builtins omit codemode.
    settings.defaultTools = ["-codemode"];
    settings.codemode = { ...object(settings.codemode), mode: "on" };
    settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 10000 };
    await writeJsonAtomic(path, settings, { mode: 0o600 });
    const extensionsConfig = join(workspace.agentDir, "virtual-worker-extensions.json");
    await writeJsonAtomic(extensionsConfig, [...DEFAULT_WORKER_EXTENSIONS, "virtual-models"], {
      mode: 0o600,
    });
    await excludeFromGit(workspace.cwd, `${projectStateRelative("virtual-models-task")}/`);
    return {
      ...workspace,
      extensionsConfig,
      async dispose() {
        await cleanupWorkerWorktrees(workspace.cwd);
        await workspace.dispose();
      },
    };
  } catch (error) {
    await workspace.dispose();
    throw error;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
async function stopChildren(cwd: string, parentPid: number) {
  const directory = join(projectStateDir(cwd, "workers"), "records");
  for (const name of await names(directory)) {
    if (!name.endsWith(".json")) continue;
    const record = object(JSON.parse(await readFile(join(directory, name), "utf8")));
    if (
      record.parentPid === parentPid &&
      record.status === "running" &&
      typeof record.pid === "number"
    )
      killGroup(record.pid, "SIGKILL");
  }
}
export async function recoverCase(prefix: string): Promise<"gone" | "stopped" | "recycled"> {
  let record: Record<string, unknown>;
  try {
    record = object(JSON.parse(await readFile(`${prefix}.process.json`, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "gone";
    throw error;
  }
  if (typeof record.pid !== "number" || !isProcessAlive(record.pid)) return "gone";
  const current = await processStartTime(record.pid);
  if (!current || typeof record.processStartedAt !== "string")
    throw new Error("Cannot verify interrupted process identity; pause before resume");
  if (current !== record.processStartedAt) return "recycled";
  killGroup(record.pid, "SIGKILL");
  if (typeof record.cwd === "string") await stopChildren(record.cwd, record.pid);
  return "stopped";
}

export async function capture(options: {
  cwd: string;
  agentDir: string;
  model: string;
  workerModel: string;
  prompt: string;
  prefix: string;
  timeoutMs: number;
  command?: string;
}) {
  const env = cleanGitEnv();
  for (const key of Object.keys(env))
    if (
      key.startsWith("PI_WORKER") ||
      key === "PI_MESSENGER_NAME" ||
      key === "PI_MESSENGER_PROJECT_ROOT"
    )
      delete env[key];
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.PI_OFFLINE = "1";
  env.PI_WORKER_MODEL = options.workerModel;
  env.PI_WORKER_MODEL_THINKING = "high";
  env.PI_WORKER_EXTENSIONS_CONFIG = join(options.agentDir, "virtual-worker-extensions.json");
  env.PI_VIRTUAL_MODEL_TRACE = `${options.prefix}.trace`;
  const stdout = createWriteStream(`${options.prefix}.events.jsonl`, { mode: 0o600 });
  const stderr = createWriteStream(`${options.prefix}.stderr.log`, { mode: 0o600 });
  const ledger = new EventLedger();
  let stderrText = "";
  let timedOut = false;
  let interrupted = false;
  let quota = false;
  let error: string | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const started = performance.now();
  const child = spawn(
    options.command ?? "pi",
    [
      "--mode",
      "json",
      "--no-session",
      "--approve",
      "--model",
      options.model,
      "--thinking",
      "medium",
      "--tools",
      "-codemode",
      "-p",
      options.prompt,
    ],
    { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stop = () => {
    if (!child.pid || stopping) return;
    stopping = true;
    killGroup(child.pid, "SIGTERM");
    force = setTimeout(() => {
      if (child.pid) killGroup(child.pid, "SIGKILL");
    }, 2000);
  };
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let tail = "";
  child.stdout.on("data", (chunk: string) => {
    try {
      ledger.push(chunk);
    } catch {
      error = "Invalid JSON event stream";
      stop();
    }
    tail = (tail + chunk).slice(-32000);
    // Only provider error fields trigger quota interruption, not task text or tool output.
    for (const match of tail.matchAll(/"errorMessage"\s*:\s*"((?:[^"\\]|\\.)*)"/g))
      if (subscriptionExhausted(match[1] ?? "")) {
        quota = true;
        stop();
      }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText = (stderrText + chunk).slice(-32000);
  });
  child.on("error", (cause) => {
    error = cause.message;
  });
  const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  try {
    await writeJsonAtomic(
      `${options.prefix}.process.json`,
      {
        pid: child.pid ?? null,
        processStartedAt: child.pid ? ((await processStartTime(child.pid)) ?? null) : null,
        cwd: options.cwd,
        deadlineAt: Date.now() + options.timeoutMs,
      },
      { mode: 0o600 },
    );
  } catch {
    error = "Cannot save durable process checkpoint";
    stop();
  }
  const exitCode = await exited;
  clearTimeout(timer);
  if (force) clearTimeout(force);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (child.pid) await stopChildren(options.cwd, child.pid);
  await Promise.all([finished(stdout), finished(stderr)]);
  const main = ledger.finish();
  return {
    main,
    pid: child.pid ?? null,
    wallMs: performance.now() - started,
    exitCode,
    stderr: stderrText,
    timedOut,
    interrupted,
    quota,
    ...(error ? { error } : {}),
  };
}

export async function harvest(cwd: string, prefix: string) {
  const directory = `${prefix}.workers`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const workers: Array<ReturnType<EventLedger["finish"]>> = [];
  const records: Record<string, unknown>[] = [];
  const streams = join(projectStateDir(cwd, "workers"), "streams");
  for (const name of await names(streams)) {
    await copyFile(join(streams, name), join(directory, name));
    if (!name.endsWith(".jsonl")) continue;
    const ledger = new EventLedger();
    ledger.push(await readFile(join(streams, name), "utf8"));
    workers.push(ledger.finish());
  }
  const recordDirectory = join(projectStateDir(cwd, "workers"), "records");
  for (const name of await names(recordDirectory))
    if (name.endsWith(".json")) {
      const value = JSON.parse(await readFile(join(recordDirectory, name), "utf8"));
      records.push(object(value));
      await writeJsonAtomic(join(directory, name), value, { mode: 0o600 });
    }
  const routes: Record<string, unknown>[] = [];
  const outputDirectory = join(prefix, "..");
  for (const name of await names(outputDirectory))
    if (name.startsWith(`${basename(prefix)}.trace.`) && name.endsWith(".jsonl")) {
      for (const line of (await readFile(join(outputDirectory, name), "utf8"))
        .split("\n")
        .filter(Boolean))
        routes.push(object(JSON.parse(line)));
    }
  return {
    workers,
    records,
    routes,
    workerUsage: sumUsage(workers.map((worker) => worker.usage)),
    classifierUsage: classifierUsage(routes),
    classifierMainUsage: classifierUsage(routes.filter((route) => route.role === "main")),
    classifierWorkerUsage: classifierUsage(routes.filter((route) => route.role === "worker")),
    routerClassifierUsage: routeUsage(routes),
  };
}

export async function recoverWorkspace(prefix: string, repository: string): Promise<boolean> {
  let setup: Record<string, unknown>;
  try {
    setup = object(JSON.parse(await readFile(`${prefix}.setup.json`, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (typeof setup.cwd !== "string" || typeof setup.agentDir !== "string")
    throw new Error("Missing interrupted workspace provenance");
  const cwd = setup.cwd;
  const root = dirname(cwd);
  if (
    basename(cwd) !== "worktree" ||
    !basename(root).startsWith("pi-codemode-") ||
    resolve(dirname(root)) !== resolve(tmpdir()) ||
    setup.agentDir !== join(root, "agent")
  )
    throw new Error("Refusing cleanup outside a recorded disposable workspace");
  const exists = await lstat(cwd).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists) return false;
  for (const name of await names(join(projectStateDir(cwd, "workers"), "records")))
    if (name.endsWith(".json")) {
      const worker = object(
        JSON.parse(await readFile(join(projectStateDir(cwd, "workers"), "records", name), "utf8")),
      );
      if (
        worker.status === "running" &&
        typeof worker.pid === "number" &&
        isProcessAlive(worker.pid)
      )
        throw new Error("Interrupted worker is still alive; pause before workspace cleanup");
    }
  const children = await harvest(cwd, prefix);
  const main = new EventLedger();
  let mainKnown = false;
  try {
    main.push(await readFile(`${prefix}.events.jsonl`, "utf8"));
    mainKnown = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const recoveredMain = main.finish();
  await writeJsonAtomic(
    `${prefix}.recovered.json`,
    {
      recoveredAt: new Date().toISOString(),
      scored: false,
      main: mainKnown ? recoveredMain : null,
      ...children,
      totalUsage: sumUsage([
        mainKnown
          ? recoveredMain.usage
          : {
              input: null,
              output: null,
              cacheRead: null,
              cacheWrite: null,
              aggregate: null,
              providerTotal: null,
            },
        children.workerUsage,
        children.classifierUsage,
      ]),
      wallMs: null,
    },
    { mode: 0o600 },
  );
  await cleanupWorkerWorktrees(cwd);
  await runGit(repository, ["worktree", "remove", "--force", cwd]);
  await rm(root, { recursive: true, force: true });
  return true;
}

export async function prepareTaskWorkspace(
  cwd: string,
  item: Pick<Case, "role" | "task">,
  sources: Record<string, string>,
) {
  const files = taskSetup(item.task, sources);
  await setupFiles(cwd, files);
  const seeded = item.role === "worker" && requiresWorkerIsolation(item.task);
  if (seeded) {
    const path = join(cwd, ".gitignore");
    let ignore = "";
    try {
      ignore = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!ignore.split(/\r?\n/).includes("/node_modules"))
      await writeFile(
        path,
        `${ignore}${ignore.endsWith("\n") || !ignore ? "" : "\n"}/node_modules\n`,
      );
    const paths = [...Object.keys(files), ".gitignore"];
    await runGit(cwd, ["add", "--", ...paths]);
    // Fixture commits stay on the disposable detached task tree; model-made changes remain separate.
    await runGit(cwd, [
      "-c",
      "user.name=Virtual model pilot",
      "-c",
      "user.email=virtual-models@example.invalid",
      "commit",
      "--quiet",
      "--only",
      "-m",
      "test: prepare isolated task fixture",
      "--",
      ...paths,
    ]);
  }
  return { seeded, setupCommit: (await runGit(cwd, ["rev-parse", "HEAD"])).trim() };
}

export async function setupFiles(cwd: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}
export async function checkTaskWorkspace(
  cwd: string,
  task: TaskId,
  sources: Record<string, string>,
  dependencyDir: string,
  reportPath: string,
) {
  if (task === "rename") {
    const evidence = await checkRename(cwd, sources, dependencyDir);
    return { passed: evidence.renameExact === true && evidence.typecheckPassed === true, evidence };
  }
  const changed = (await runGit(cwd, ["diff", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  const untracked = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  const dependencyLink = join(cwd, "node_modules");
  const validLink = await lstat(dependencyLink).then(
    async (info) =>
      info.isSymbolicLink() && (await realpath(dependencyLink)) === (await realpath(dependencyDir)),
    () => false,
  );
  const unexpected = untracked.filter(
    (path) =>
      !(path === "node_modules" && validLink) && !(task === "diagnosis" && path === DIAGNOSIS_PATH),
  );
  if (task !== "fix")
    return {
      passed: changed.length === 0 && unexpected.length === 0,
      evidence: { changed, unexpected },
    };
  let testsPassed = false;
  try {
    await execute(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "test/lib/arrow-keys.test.ts",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { cwd, env: cleanGitEnv(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    const report = object(JSON.parse(await readFile(reportPath, "utf8")));
    testsPassed =
      report.success === true &&
      typeof report.numPassedTests === "number" &&
      report.numPassedTests >= 5 &&
      report.numFailedTests === 0;
  } catch {
    /* A failing independent test is a task failure, not an infrastructure retry. */
  }
  const golden = await readFile(join(cwd, "lib/arrow-keys.ts"), "utf8");
  const allowed = ["lib/arrow-keys.ts", "test/lib/arrow-keys.test.ts"];
  const passed =
    golden === sources["lib/arrow-keys.ts"] &&
    changed.includes("test/lib/arrow-keys.test.ts") &&
    changed.every((path) => allowed.includes(path)) &&
    unexpected.length === 0 &&
    testsPassed;
  return {
    passed,
    evidence: {
      changed,
      unexpected,
      testsPassed,
      goldenRestored: golden === sources["lib/arrow-keys.ts"],
    },
  };
}

export async function resetState(cwd: string) {
  await cleanupWorkerWorktrees(cwd);
  await rm(projectStateDir(cwd, "workers"), { recursive: true, force: true });
  await rm(projectStateDir(cwd, "virtual-models-task"), { recursive: true, force: true });
}
