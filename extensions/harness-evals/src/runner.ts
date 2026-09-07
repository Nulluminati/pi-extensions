/**
 * Eval task runner: materializes fixtures into a fresh temp project, runs a
 * noninteractive Pi session against the prompt, then grades the outcome with
 * the task's shell checks. Pure Node — importable from the extension and
 * from CLI scripts without a Pi runtime.
 */

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanGitEnv } from "../../../lib/git.ts";
import type { CheckResult, EvalResult, EvalTask } from "./types.ts";

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
  finalText?: string;
}

/** Run `pi --mode json --no-session -p <prompt>` and summarize its events. */
export async function runPiSession(options: {
  cwd: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  extensionPaths: string[];
  piBin?: string;
  env?: Record<string, string>;
}): Promise<SessionOutcome> {
  const args = ["--mode", "json", "--no-session", "--no-extensions", "-nc", "-p", options.prompt];
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
            usage?: { input?: number; output?: number };
          };
        };
        if (event.type !== "message_end" || event.message?.role !== "assistant") return;
        const usage = event.message.usage;
        if (usage) {
          inputTokens += usage.input ?? 0;
          outputTokens += usage.output ?? 0;
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

// --- Full task ---

export interface RunTaskOptions {
  model?: string;
  timeoutMs?: number;
  extensionPaths?: string[];
  piBin?: string;
  keepWorkspace?: boolean;
  workspaceDir?: string;
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
    });

    const checks: CheckResult[] = session.timedOut
      ? [{ name: task.checks.name, ok: false, output: "task timed out before checks could run" }]
      : [await runCheck(task.checks, workspace.dir)];

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
      error: (err as Error).message,
      at,
    };
  } finally {
    if (options.keepWorkspace !== true) {
      await workspace.cleanup();
    }
  }
}
