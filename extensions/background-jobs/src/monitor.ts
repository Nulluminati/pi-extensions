/**
 * Monitor engine: polls a command on an interval until a condition holds
 * (or a deadline / broken-poll threshold fires), then wakes the agent.
 * Polls are scheduled recursively AFTER each poll completes, with an
 * in-flight guard, so they never overlap regardless of how long exec takes.
 */

import { appendBuffer, slugify } from "./format.ts";
import { createJob, finalizeJob, type JobRegistry } from "./registry.ts";
import type { Job, JobEvents, SatisfyOn } from "./types.ts";

export const DEFAULT_MONITOR_INTERVAL_S = 10;
export const DEFAULT_MONITOR_TIMEOUT_S = 600;
export const MIN_MONITOR_INTERVAL_S = 1; // floor; sub-second polls flood commands
export const MONITOR_POLL_FAIL_THRESHOLD = 3; // consecutive broken polls -> abort

export interface StartMonitorOptions {
  registry: JobRegistry;
  command: string;
  cwd: string;
  satisfyOn: SatisfyOn;
  pattern?: RegExp | undefined;
  patternSource?: string | undefined;
  intervalSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
  label?: string | undefined;
  exec: (
    command: string,
    args: string[],
    options: { timeout?: number; cwd?: string },
  ) => Promise<{
    stdout?: string;
    stderr?: string;
    code?: number | null;
  }>;
  events: JobEvents;
}

interface ExecResult {
  stdout?: string;
  stderr?: string;
  code?: number | null;
}

export function startMonitor(options: StartMonitorOptions): Job {
  const { registry, command, satisfyOn, events } = options;
  const label = options.label ?? slugify(command);
  const rawInterval = options.intervalSeconds ?? DEFAULT_MONITOR_INTERVAL_S;
  const intervalSeconds =
    Number.isFinite(rawInterval) && rawInterval >= MIN_MONITOR_INTERVAL_S
      ? rawInterval
      : DEFAULT_MONITOR_INTERVAL_S;
  const rawTimeout = options.timeoutSeconds ?? DEFAULT_MONITOR_TIMEOUT_S;
  const timeoutSeconds =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_MONITOR_TIMEOUT_S;

  const job = createJob(registry, {
    kind: "monitor",
    label,
    command,
    intervalSeconds,
    timeoutSeconds,
    deadline: Date.now() + timeoutSeconds * 1000,
    satisfyOn,
    ...(options.pattern ? { pattern: options.pattern } : {}),
    ...(options.patternSource ? { patternSourceString: options.patternSource } : {}),
  });

  const evaluate = (out: string, code: number | null | undefined): boolean => {
    switch (satisfyOn) {
      case "exit_zero":
        return code === 0;
      case "exit_nonzero":
        return code !== 0 && code != null;
      case "stdout_matches":
        return options.pattern ? options.pattern.test(out) : false;
      case "stdout_not_matches":
        return options.pattern ? !options.pattern.test(out) : false;
      default:
        return false;
    }
  };

  const tick = async (): Promise<void> => {
    if (job.status !== "running" || job.polling) return;
    job.polling = true;
    let result: ExecResult;
    try {
      // Route through /bin/sh -c explicitly: exec uses spawn with shell:false,
      // so anything with shell syntax (pipelines, redirects, &&) would fail.
      result = (await options.exec("/bin/sh", ["-c", command], {
        timeout: Math.max(5, intervalSeconds) * 1000,
        cwd: options.cwd,
      })) as ExecResult;
    } catch (err) {
      result = { stderr: (err as Error).message, code: null };
    }
    job.polling = false;
    if (job.status !== "running") return; // cancelled/timed out mid-poll

    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    appendBuffer(job, out);

    // A structurally-broken poll ("command not found" in stderr) can never
    // satisfy — abort with a diagnostic instead of running to the deadline.
    // Legit pending polls (test -f, nc -z, grep -q) fail without that marker
    // and must NOT be classified as broken.
    const notFound = /(?:command not found|not found|No such file or directory)/i.test(
      result.stderr ?? "",
    );
    job.pollFailures = notFound ? (job.pollFailures ?? 0) + 1 : 0;
    if ((job.pollFailures ?? 0) >= MONITOR_POLL_FAIL_THRESHOLD) {
      job.exitCode = result.code ?? undefined;
      job.status = "timeout";
      const hint =
        "every poll failed to run its command (command not found in stderr). The poll command likely references a missing or mistyped binary";
      events.notify("error", `monitor #${job.id} "${label}" aborting: ${hint}.`);
      events.wake(
        `[monitor #${job.id} "${label}" aborted after ${job.pollFailures} consecutive broken polls: ${hint}. Read the last poll with the jobs tool (action=tail, jobId=${job.id}).`,
      );
      finalizeJob(registry, job);
      events.onChange();
      return;
    }

    if (evaluate(result.stdout ?? "", result.code)) {
      job.exitCode = result.code ?? undefined;
      job.status = "satisfied";
      events.notify("info", `monitor #${job.id} "${label}" satisfied (${satisfyOn})`);
      // Trusted wake: no command output.
      events.wake(
        `[monitor #${job.id} "${label}" satisfied: ${satisfyOn}, exit ${result.code ?? "?"}]. Read the result with the jobs tool (action=tail, jobId=${job.id}).`,
      );
      finalizeJob(registry, job);
      events.onChange();
      return;
    }

    if (Date.now() >= (job.deadline ?? 0)) {
      job.exitCode = result.code ?? undefined;
      job.status = "timeout";
      events.notify("warning", `monitor #${job.id} "${label}" timed out after ${timeoutSeconds}s`);
      events.wake(
        `[monitor #${job.id} "${label}" timed out after ${timeoutSeconds}s without satisfying ${satisfyOn}. Read the last poll with the jobs tool (action=tail, jobId=${job.id}).`,
      );
      finalizeJob(registry, job);
      events.onChange();
      return;
    }

    // Schedule the NEXT poll only after this one finished -> no overlap.
    job.timer = setTimeout(() => void tick(), intervalSeconds * 1000);
  };

  // First tick immediately so short conditions resolve fast.
  void tick();

  events.onChange();
  return job;
}
