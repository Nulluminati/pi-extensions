import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { cleanGitEnv, runGit } from "../../lib/git.ts";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";
import { projectConfigPath, projectStateDir } from "../../lib/paths.ts";
import { JsonlMetrics } from "./metrics.ts";
import {
  FAILURE_FIXTURE,
  FAILURE_FIXTURE_PATH,
  HELPER_FROM,
  HELPER_TO,
  type TaskId,
} from "./tasks.ts";

const execute = promisify(execFile);

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function absolutePath(path: string, base: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(base, path);
}

export async function trackedSources(cwd: string): Promise<Record<string, string>> {
  const names = (await runGit(cwd, ["ls-files", "-z", "--", "*.ts"])).split("\0").filter(Boolean);
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(join(cwd, name), "utf8")] as const),
  );
  return Object.fromEntries(entries);
}

/** Preserve normal resources, but replace this installed package with the fixed pinned tree. */
async function prepareAgentDir(
  root: string,
  repository: string,
  worktree: string,
): Promise<string> {
  const source = getAgentDir();
  const target = join(root, "agent");
  await mkdir(target, { mode: 0o700 });
  const settings = object(JSON.parse(await readFile(join(source, "settings.json"), "utf8")));
  const common = await realpath(
    resolve(repository, (await runGit(repository, ["rev-parse", "--git-common-dir"])).trim()),
  );
  let replacements = 0;
  const packages: unknown[] = [];
  for (const item of Array.isArray(settings.packages) ? settings.packages : []) {
    const config = object(item);
    const packageSource = typeof item === "string" ? item : config.source;
    let matches = false;
    if (typeof packageSource === "string" && !/^(npm:|git:|https?:)/.test(packageSource)) {
      const local = absolutePath(packageSource, source);
      try {
        const other = await runGit(local, ["rev-parse", "--git-common-dir"]);
        matches = (await realpath(resolve(local, other.trim()))) === common;
      } catch {
        // A local package need not be a git repository.
      }
    }
    if (matches) {
      replacements++;
      packages.push(typeof item === "string" ? worktree : { ...config, source: worktree });
    } else {
      packages.push(item);
    }
  }
  if (replacements !== 1)
    throw new Error(`Expected one normal package for this repository; found ${replacements}`);
  settings.packages = packages;
  settings.codemode = { ...object(settings.codemode), mode: "on" };
  // Relative resource paths otherwise resolve against the temporary agent directory.
  for (const key of ["extensions", "skills", "prompts", "themes"]) {
    if (!Array.isArray(settings[key])) continue;
    settings[key] = (settings[key] as unknown[]).map((value) => {
      if (typeof value !== "string") return value;
      const prefix = /^[!+-]/.exec(value)?.[0] ?? "";
      const path = value.slice(prefix.length);
      return path.startsWith("builtin:") ? value : prefix + absolutePath(path, source);
    });
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "settings.json" || entry.name.endsWith(".lock")) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, 0o600);
    } else if (
      ["extensions", "skills", "prompts", "themes", "npm", "git", "models-store"].includes(
        entry.name,
      )
    ) {
      await symlink(from, to);
    }
  }
  await writeJsonAtomic(join(target, "settings.json"), settings);
  return target;
}

export async function createWorkspace(repository: string, commit: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-"));
  const cwd = join(root, "worktree");
  let added = false;
  try {
    await runGit(repository, ["worktree", "add", "--detach", cwd, commit]);
    added = true;
    await symlink(join(repository, "node_modules"), join(cwd, "node_modules"));
    const agentDir = await prepareAgentDir(root, repository, cwd);
    return {
      cwd,
      agentDir,
      async reset(arm: string, task: TaskId) {
        await runGit(cwd, ["reset", "--hard", commit]);
        await runGit(cwd, ["clean", "-fd"]);
        // Ignored session state must not retain another run's file reservations.
        await rm(projectStateDir(cwd, "messenger"), { recursive: true, force: true });
        // Directory-only ignore patterns do not protect a node_modules symlink from git clean.
        await rm(join(cwd, "node_modules"), { recursive: true, force: true });
        await symlink(join(repository, "node_modules"), join(cwd, "node_modules"));
        const projectSettings = projectConfigPath(cwd, "settings.json");
        await rm(projectSettings, { force: true });
        if (arm === "only") {
          await mkdir(dirname(projectSettings), { recursive: true });
          await writeJsonAtomic(projectSettings, { codemode: { mode: "only" } });
        }
        if (task === "failure") await writeFile(join(cwd, FAILURE_FIXTURE_PATH), FAILURE_FIXTURE);
      },
      async dispose() {
        await runGit(repository, ["worktree", "remove", "--force", cwd]);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (added) await runGit(repository, ["worktree", "remove", "--force", cwd]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function referenceTestCount(cwd: string): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-reference-"));
  const reportPath = join(directory, "report.json");
  try {
    await execute(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "test/extensions/todos.test.ts",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { cwd, env: cleanGitEnv(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const result = object(JSON.parse(await readFile(reportPath, "utf8")));
    if (
      result.success !== true ||
      typeof result.numPassedTests !== "number" ||
      result.numFailedTests !== 0
    )
      throw new Error("Reference todos tests did not pass cleanly");
    return result.numPassedTests;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkRename(
  cwd: string,
  sources: Record<string, string>,
  dependencyDir: string,
) {
  const changed = (await runGit(cwd, ["diff", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  const expected = Object.entries(sources).filter(([, source]) =>
    new RegExp(`\\b${HELPER_FROM}\\b`).test(source),
  );
  const expectedNames = expected.map(([path]) => path).sort();
  const untracked = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  let knownDependencyLink = false;
  try {
    const link = join(cwd, "node_modules");
    knownDependencyLink =
      (await lstat(link)).isSymbolicLink() &&
      (await realpath(link)) === (await realpath(dependencyDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const unexpectedFiles = untracked.filter(
    (path) => path !== "node_modules" || !knownDependencyLink,
  );
  let renameExact =
    unexpectedFiles.length === 0 && JSON.stringify(changed) === JSON.stringify(expectedNames);
  for (const [path, source] of expected) {
    try {
      const actual = await readFile(join(cwd, path), "utf8");
      if (actual !== source.replace(new RegExp(`\\b${HELPER_FROM}\\b`, "g"), HELPER_TO))
        renameExact = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      renameExact = false;
    }
  }
  let typecheckPassed = false;
  try {
    await execute("npx", ["--no-install", "tsc", "--noEmit"], {
      cwd,
      env: cleanGitEnv(),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    typecheckPassed = true;
  } catch {
    // A failing typecheck is a task failure, not a benchmark infrastructure error.
  }
  return { renameExact, typecheckPassed, changedFiles: changed, unexpectedFiles };
}

export async function captureRun(options: {
  cwd: string;
  agentDir: string;
  model: string;
  arm: string;
  prompt: string;
  outputPrefix: string;
  timeoutMs: number;
}) {
  const args = [
    "--mode",
    "json",
    "--no-session",
    "--approve",
    "--model",
    options.model,
    "--tools",
    options.arm === "off" ? "-codemode" : "+codemode",
    options.prompt,
  ];
  const env = cleanGitEnv();
  env.PI_CODING_AGENT_DIR = options.agentDir;
  for (const key of Object.keys(env))
    if (key.startsWith("PI_WORKER") || key === "PI_MESSENGER_NAME") delete env[key];
  const stdout = createWriteStream(`${options.outputPrefix}.events.jsonl`, { mode: 0o600 });
  const stderr = createWriteStream(`${options.outputPrefix}.stderr.log`, { mode: 0o600 });
  const parser = new JsonlMetrics();
  const started = performance.now();
  const child = spawn("pi", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let error: string | undefined;
  let timedOut = false;
  let stderrTail = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  const terminate = () => {
    if (!child.pid || terminating) return;
    terminating = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
    killTimer = setTimeout(() => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }, 5_000);
  };
  const interrupted = () => {
    timedOut = false;
    error = "Evaluation interrupted";
    terminate();
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const timeout = setTimeout(() => {
    if (error) return;
    timedOut = true;
    error = `Run exceeded ${options.timeoutMs}ms`;
    terminate();
  }, options.timeoutMs);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (error) return;
    try {
      parser.push(chunk);
    } catch (cause) {
      error = String(cause);
      terminate();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-32_000);
  });
  child.on("error", (cause) => {
    error = cause.message;
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => done({ code, signal }));
  });
  const wallMs = performance.now() - started;
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  await Promise.all([finished(stdout), finished(stderr)]);
  let metrics = parser.snapshot();
  if (!error) {
    try {
      metrics = parser.finish();
    } catch (cause) {
      error = String(cause);
    }
  }
  if (
    !error &&
    (exit.code !== 0 || !metrics.settled || metrics.aborted || metrics.stopReason !== "stop")
  ) {
    error = `Incomplete run: exit=${exit.code} signal=${exit.signal} settled=${metrics.settled} aborted=${metrics.aborted} stopReason=${metrics.stopReason}`;
  }
  if (!error && (metrics.models.length !== 1 || metrics.models[0] !== options.model))
    error = `Unexpected models: ${metrics.models.join(", ")}`;
  return {
    metrics,
    wallMs,
    exitCode: exit.code,
    stderrTail,
    timedOut,
    ...(error ? { error } : {}),
  };
}
