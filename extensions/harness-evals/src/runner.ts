/**
 * Eval task runner: materializes fixtures into a fresh temp project, runs a
 * noninteractive Pi session against the prompt, then grades the outcome with
 * the task's shell checks. Pure Node — importable from the extension and
 * from CLI scripts without a Pi runtime.
 */

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanGitEnv } from "../../../lib/git.ts";
import type { CheckResult, EvalQuality, EvalResult, EvalTask } from "./types.ts";

const execFileAsync = promisify(execFile);

// --- Constants ---

const CHECK_OUTPUT_TAIL = 2000;

// --- Setup ---

export interface TaskWorkspace {
  dir: string;
  cleanup(): Promise<void>;
}

/** Create an isolated task workspace: fixtures + git repo, nothing else. */
export async function materializeTask(task: EvalTask, baseDir?: string): Promise<TaskWorkspace> {
  const dir = baseDir ?? (await mkdtemp(join(tmpdir(), "eval-task-")));
  await mkdir(dir, { recursive: true });
  for (const fixture of task.fixtures) {
    const target = join(dir, fixture.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, fixture.content, "utf8");
    if (fixture.executable) await chmod(target, 0o755);
  }
  const gitOpts = { cwd: dir, env: cleanGitEnv() };
  await execFileAsync("git", ["init", "-q"], gitOpts).catch(() => {});
  await execFileAsync("git", ["config", "user.email", "eval@example.com"], gitOpts).catch(() => {});
  await execFileAsync("git", ["config", "user.name", "Eval"], gitOpts).catch(() => {});
  await execFileAsync("git", ["add", "-A"], gitOpts).catch(() => {});
  await execFileAsync("git", ["commit", "-qm", "fixture baseline"], gitOpts).catch(() => {});
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// --- Session run ---

interface SessionOutcome {
  exitCode: number | null;
  timedOut: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  finalText?: string;
}

/** Run `pi --mode json -p <prompt>` and summarize its events. When
 * sessionPath is set, the session JSONL is kept there for trajectory
 * debugging (parity with the official pi terminal-bench adapter). */
export async function runPiSession(options: {
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  extensionPaths: string[];
  piBin?: string;
  env?: Record<string, string>;
  sessionPath?: string;
}): Promise<SessionOutcome> {
  const args = ["--mode", "json", "--no-extensions", "-nc", "-p", options.prompt];
  if (options.sessionPath) args.push("--session", options.sessionPath);
  if (options.model) args.push("--model", options.model);
  for (const ext of options.extensionPaths) args.push("-e", ext);

  return new Promise((resolve) => {
    const child = spawn(options.piBin ?? "pi", args, {
      cwd: options.cwd,
      env: { ...cleanGitEnv(), ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheTokens = 0;
    let costUsd = 0;
    let finalText: string | undefined;
    let timedOut = false;
    let stderrTail = "";

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, options.timeoutMs);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              cost?: { total?: number };
            };
          };
        };
        if (event.type !== "message_end" || event.message?.role !== "assistant") return;
        const usage = event.message.usage;
        if (usage) {
          inputTokens += usage.input ?? 0;
          outputTokens += usage.output ?? 0;
          cacheTokens += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          costUsd += usage.cost?.total ?? 0;
        }
        const text = (event.message.content ?? [])
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text ?? "")
          .join("")
          .trim();
        if (text) finalText = text;
      } catch {
        // Not JSON (banner noise etc.) — ignore.
      }
    };

    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      handleLine(stdoutBuffer); // flush any trailing partial line
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        inputTokens,
        outputTokens,
        cacheTokens,
        costUsd,
        ...(finalText !== undefined ? { finalText } : {}),
        ...(stderrTail && timedOut ? { finalText: finalText ?? `stderr: ${stderrTail}` } : {}),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        costUsd: 0,
      });
      void err;
    });
  });
}

// --- Checks ---

export async function runCheck(
  check: { name: string; command: string },
  cwd: string,
): Promise<CheckResult> {
  try {
    await execFileAsync("/bin/sh", ["-c", check.command], {
      cwd,
      timeout: 120_000,
      env: cleanGitEnv(),
    });
    return { name: check.name, ok: true, output: "passed" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    return {
      name: check.name,
      ok: false,
      output: output.length > CHECK_OUTPUT_TAIL ? `${output.slice(-CHECK_OUTPUT_TAIL)}` : output,
    };
  }
}

// --- Quality judging ---

const JUDGE_SKIP_DIRS = new Set([".git", ".broken", ".grader", ".pi", ".auto", "node_modules"]);
const JUDGE_FILE_BYTES = 8_000;
const JUDGE_TOTAL_BYTES = 48_000;
const JUDGE_TIMEOUT_MS = 240_000;

/** Collect workspace text files for the judge, bounded. */
export async function collectWorkspace(dir: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  async function walk(current: string, rel: string): Promise<void> {
    if (total >= JUDGE_TOTAL_BYTES) return;
    let entries: string[] = [];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (total >= JUDGE_TOTAL_BYTES) return;
      const full = join(current, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const s = await stat(full).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) {
        if (!JUDGE_SKIP_DIRS.has(entry)) await walk(full, relPath);
        continue;
      }
      if (s.size > 40_000) continue;
      if (entry === "session.jsonl") continue; // agent transcript must not bias the judge
      const content = await readFile(full, "utf8").catch(() => undefined);
      if (content === undefined) continue; // binary
      const bounded =
        content.length > JUDGE_FILE_BYTES
          ? `${content.slice(0, JUDGE_FILE_BYTES)}\n…[truncated]`
          : content;
      const budget = Math.min(bounded.length, JUDGE_TOTAL_BYTES - total);
      total += budget;
      parts.push(`=== ${relPath} ===\n${bounded.slice(0, budget)}`);
    }
  }
  await walk(dir, "");
  return parts.join("\n\n");
}

/** Parse the judge's JSON verdict out of its final message. */
export function parseJudgeVerdict(text: string): EvalQuality | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const clamp = (v: unknown): number | undefined => {
      const n = typeof v === "number" ? v : Number.parseFloat(String(v));
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : undefined;
    };
    const specAdherence = clamp(parsed.specAdherence);
    const codeQuality = clamp(parsed.codeQuality);
    const robustness = clamp(parsed.robustness);
    const overall = clamp(parsed.overall);
    if (
      specAdherence === undefined ||
      codeQuality === undefined ||
      robustness === undefined ||
      overall === undefined
    ) {
      return undefined;
    }
    return {
      specAdherence,
      codeQuality,
      robustness,
      overall,
      ...(typeof parsed.notes === "string" && parsed.notes.trim()
        ? { notes: parsed.notes.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function buildJudgePrompt(task: EvalTask, workspace: string): string {
  return [
    "You are grading an AI-generated solution to a coding task. Grade ONLY the final workspace contents.",
    "You are not told which model or configuration produced it. Be rigorous and calibrated: 7 is good professional work, 10 is exceptional, 5 means usable but sloppy, below 5 means broken or badly off-spec.",
    "",
    `## Task given to the agent\n${task.prompt}`,
    "",
    `## Acceptance checks the workspace already passed or failed\n${task.checks.name}`,
    "",
    "## Final workspace files\n```\n" + workspace + "\n```",
    "",
    "Grade these axes from 0 to 10 (one decimal is fine):",
    "- specAdherence: does the code fulfill exactly what was asked, including edge cases named in the task or spec files?",
    "- codeQuality: readability, structure, naming, sensible error handling; professional quality.",
    "- robustness: would this survive edge cases and small requirement changes, or is it overfit to the visible tests?",
    "- overall: your weighted judgment of the solution's quality.",
    "- notes: one short paragraph citing concrete evidence from the files.",
    "",
    'Respond with ONLY a JSON object: {"specAdherence":n,"codeQuality":n,"robustness":n,"overall":n,"notes":"..."}',
  ].join("\n");
}

// --- Harness disclosure ---

let cachedPiVersion: string | undefined;

/** pi version, resolved once per process for harness disclosure records. */
export async function getPiVersion(piBin = "pi"): Promise<string> {
  if (cachedPiVersion !== undefined) return cachedPiVersion;
  try {
    const { stdout } = await execFileAsync(piBin, ["--version"], {
      timeout: 30_000,
      env: cleanGitEnv(),
    });
    cachedPiVersion = stdout.trim();
  } catch (err) {
    cachedPiVersion = `unknown (${(err as Error).message})`;
  }
  return cachedPiVersion;
}

/**
 * Blind quality judgment of a completed run. Runs a fixed judge model over
 * the final workspace; the judge never sees which configuration produced it.
 * One retry on an unparseable verdict — judge output is JSON in prose and
 * occasionally gets wrapped or truncated.
 */
export async function judgeRun(options: {
  dir: string;
  task: EvalTask;
  judgeModel: string;
  timeoutMs?: number;
  piBin?: string;
}): Promise<EvalQuality | undefined> {
  const workspace = await collectWorkspace(options.dir);
  const session = await runPiSession({
    cwd: options.dir,
    prompt: buildJudgePrompt(options.task, workspace),
    model: options.judgeModel,
    timeoutMs: options.timeoutMs ?? JUDGE_TIMEOUT_MS,
    extensionPaths: [],
    ...(options.piBin !== undefined ? { piBin: options.piBin } : {}),
  });
  if (session.finalText !== undefined) {
    const verdict = parseJudgeVerdict(session.finalText);
    if (verdict !== undefined) return verdict;
  }
  // Retry once: malformed or empty verdicts are usually transient formatting.
  const retry = await runPiSession({
    cwd: options.dir,
    prompt: buildJudgePrompt(options.task, workspace),
    model: options.judgeModel,
    timeoutMs: options.timeoutMs ?? JUDGE_TIMEOUT_MS,
    extensionPaths: [],
    ...(options.piBin !== undefined ? { piBin: options.piBin } : {}),
  });
  if (retry.finalText === undefined) return undefined;
  return parseJudgeVerdict(retry.finalText);
}

// --- Full task ---

export interface RunTaskOptions {
  model?: string;
  timeoutMs?: number;
  extensionPaths?: string[];
  piBin?: string;
  keepWorkspace?: boolean;
  workspaceDir?: string;
  /** When set, a blind judge grades the final workspace after the run. */
  judge?: { model: string; timeoutMs?: number; piBin?: string };
  /** Keep the pi session JSONL inside the workspace (default: kept with it). */
  captureSession?: boolean;
}

/** Run one eval task end to end and grade it. */
export async function runEvalTask(
  task: EvalTask,
  options: RunTaskOptions = {},
): Promise<EvalResult> {
  const workspace = await materializeTask(task, options.workspaceDir);
  const at = Date.now();
  try {
    const session = await runPiSession({
      cwd: workspace.dir,
      prompt: task.prompt,
      ...(options.model !== undefined ? { model: options.model } : {}),
      timeoutMs: options.timeoutMs ?? task.timeoutMs,
      extensionPaths: options.extensionPaths ?? [],
      ...(options.piBin !== undefined ? { piBin: options.piBin } : {}),
      ...(options.captureSession === false
        ? {}
        : { sessionPath: join(workspace.dir, "session.jsonl") }),
    });

    const checks: CheckResult[] = session.timedOut
      ? [{ name: task.checks.name, ok: false, output: "task timed out before checks could run" }]
      : [await runCheck(task.checks, workspace.dir)];

    let quality: EvalQuality | undefined;
    if (options.judge !== undefined) {
      // (judge retries happen inside judgeRun)
      quality = await judgeRun({
        dir: workspace.dir,
        task,
        judgeModel: options.judge.model,
        ...(options.judge.timeoutMs !== undefined ? { timeoutMs: options.judge.timeoutMs } : {}),
        ...(options.judge.piBin !== undefined ? { piBin: options.judge.piBin } : {}),
      });
    }

    return {
      taskId: task.id,
      model: options.model ?? "(default)",
      pass: checks.every((c) => c.ok),
      checks,
      durationMs: Date.now() - at,
      exitCode: session.exitCode,
      timedOut: session.timedOut,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      ...(session.finalText !== undefined ? { finalText: session.finalText } : {}),
      ...(quality !== undefined ? { quality } : {}),
      cacheTokens: session.cacheTokens,
      costUsd: session.costUsd,
      harness: {
        piVersion: await getPiVersion(options.piBin),
        model: options.model ?? "(default)",
        extensionPaths: options.extensionPaths ?? [],
        ...(options.judge !== undefined ? { judgeModel: options.judge.model } : {}),
        timeoutMs: options.timeoutMs ?? task.timeoutMs,
      },
      at,
    };
  } catch (err) {
    return {
      taskId: task.id,
      model: options.model ?? "(default)",
      pass: false,
      checks: [{ name: task.checks.name, ok: false, output: (err as Error).message }],
      durationMs: Date.now() - at,
      exitCode: null,
      timedOut: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      harness: {
        piVersion: await getPiVersion(options.piBin),
        model: options.model ?? "(default)",
        extensionPaths: options.extensionPaths ?? [],
        ...(options.judge !== undefined ? { judgeModel: options.judge.model } : {}),
        timeoutMs: options.timeoutMs ?? task.timeoutMs,
      },
      error: (err as Error).message,
      at,
    };
  } finally {
    if (options.keepWorkspace !== true) {
      await workspace.cleanup();
    }
  }
}
