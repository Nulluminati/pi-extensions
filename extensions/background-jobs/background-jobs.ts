/**
 * Background Jobs
 *
 * Lets the agent run long shell commands detached, poll commands until a
 * condition holds, and manage the resulting job registry — without blocking
 * the turn. The agent is woken asynchronously when a job finishes.
 *
 * Tools:
 * - background : run a command detached; wake the agent on exit (and
 *   optionally the first time output matches a pattern).
 * - monitor    : poll a command on an interval until a predicate holds
 *   (or a timeout fires); wake the agent with the result.
 * - jobs       : list / status / tail / cancel / view over the registry.
 *
 * Wake-ups are delivered via pi.sendMessage with triggerTurn:true and
 * deliverAs:"steer" so the message injects right after the current tool-call
 * batch; when the agent is idle, triggerTurn starts a fresh turn. Wake
 * messages are extension-authored and trusted: they carry only the job id and
 * exit code / status word — never command output, which stays in the registry
 * and is read on demand via the jobs tool. This keeps a malicious command's
 * stdout from being injected as user-authored content.
 *
 * In print and json modes pi exits when the turn ends, so nothing can wake
 * the agent and pending jobs die with the process. The background and monitor
 * tools are deactivated there and refuse to start if called anyway.
 *
 * Output is also spooled to <agentDir>/background-jobs/job-<id>-<label>.log
 * so a future restart-reconcile layer can audit past jobs; the registry
 * itself is in-memory and session-scoped.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { agentStateDir } from "../../lib/paths.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { setStripWidget, WIDGET_PRIORITY_JOBS } from "../../lib/widget-strip.ts";
import { executeJobsAction, openJobsPanel } from "./src/jobs.ts";
import { startMonitor } from "./src/monitor.ts";
import {
  activeJobs,
  buildSnapshot,
  createRegistry,
  formatStatusText,
  type JobRegistry,
} from "./src/registry.ts";
import { cancelJob, pruneSpoolDir, startBackgroundJob } from "./src/runner.ts";
import {
  BACKGROUND_PARAMETERS,
  JOBS_OUTPUT,
  JOBS_PARAMETERS,
  MONITOR_PARAMETERS,
} from "./src/schemas.ts";
import type { JobEvents } from "./src/types.ts";
import { createJobsWidget } from "./src/widget.ts";

// --- Constants ---

const WIDGET_KEY = "background-jobs";
const SNAPSHOT_TYPE = "background-jobs";
const WAKE_CUSTOM_TYPE = "background-jobs:wake";

// Tools that rely on a later wake-up. Print and json modes run one turn and
// exit, so these tools cannot deliver their result there.
const WAKE_TOOLS = new Set(["background", "monitor"]);

// Status fallback key for pi's default footer; mirrors WIDGET_KEY so the
// status bar's line-2 skip list can suppress it while its widget is visible.
const STATUS_KEY = "background-jobs";
const STATUS_ICON = "▣";
const STATUS_ICON_COLOR = "accent";
const STATUS_TEXT_COLOR = "muted";

// --- Helpers ---

function err(code: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: code },
    terminate: true as const,
  };
}

function isSingleTurnMode(mode: ExtensionContext["mode"]): boolean {
  return mode === "print" || mode === "json";
}

function singleTurnErr() {
  return err(
    "single_turn_mode",
    "Background jobs are unavailable in print and json modes: pi exits when the turn ends and stops the job. Run the command with the bash tool and a sufficient timeout instead.",
  );
}

// --- Extension ---

export default async function backgroundJobsExtension(pi: ExtensionAPI) {
  const registry: JobRegistry = createRegistry();
  let shuttingDown = false;
  // The last ctx.ui seen by any tool call — used to refresh visuals from async callbacks.
  let lastUi: ExtensionUIContext | undefined;

  function persist(): void {
    // Async job callbacks can fire after the session has been replaced,
    // reloaded, or ended — at which point the captured pi handle is stale.
    // There is nothing left to persist into in that case; drop it quietly and
    // log anything that looks like a real failure.
    try {
      pi.appendEntry(SNAPSHOT_TYPE, buildSnapshot(registry));
    } catch (err) {
      const message = (err as Error).message;
      if (!message.includes("stale")) {
        console.error(`[background-jobs] persist failed: ${message}`);
      }
    }
  }

  // Publishes the widget-first surfaces: the framed Jobs panel above the
  // editor, plus the setStatus fallback pi's default footer shows when the
  // bundled status bar is disabled. The status bar skips STATUS_KEY on its
  // second line so the state never double-renders.
  function publish(ui: ExtensionUIContext): void {
    const active = activeJobs(registry);
    const statusText = formatStatusText(registry);
    try {
      setStripWidget(ui, "aboveEditor", {
        key: WIDGET_KEY,
        priority: WIDGET_PRIORITY_JOBS,
        factory: active.length > 0 ? createJobsWidget(registry) : undefined,
      });
      ui.setStatus(
        STATUS_KEY,
        statusText === undefined
          ? undefined
          : formatStatusLine(ui.theme, {
              icon: STATUS_ICON,
              prefix: "Jobs",
              text: statusText,
              iconColor: STATUS_ICON_COLOR,
              textColor: STATUS_TEXT_COLOR,
            }),
      );
    } catch (err) {
      const message = (err as Error).message;
      if (!message.includes("stale")) {
        console.error(`[background-jobs] publish failed: ${message}`);
      }
    }
  }

  function refreshWidget(): void {
    const ui = lastUi;
    if (!ui?.setWidget) return;
    publish(ui);
  }

  const events: JobEvents = {
    wake(message, details = {}): void {
      if (shuttingDown) return; // don't trigger turns during/after shutdown
      try {
        pi.sendMessage(
          {
            customType: WAKE_CUSTOM_TYPE,
            content: [{ type: "text", text: message }],
            display: false,
            details: { source: "background-jobs", trusted: true, ...details },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      } catch (err) {
        console.error(`[background-jobs] wake failed: ${(err as Error).message}`);
      }
    },
    notify(level, message): void {
      lastUi?.notify(message, level);
    },
    onChange(): void {
      persist();
      refreshWidget();
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    // Retention runs against the pre-reset registry so logs for jobs that are
    // still terminating are never deletion candidates.
    const liveSpoolPaths = new Set(
      activeJobs(registry)
        .map((job) => job.spoolPath)
        .filter((path): path is string => typeof path === "string"),
    );
    // Fresh session state: clear stale timers and rebuild the registry.
    for (const job of activeJobs(registry)) {
      if (job.timer) clearTimeout(job.timer);
    }
    registry.jobs.clear();
    registry.nextId = 1;
    lastUi = undefined;
    shuttingDown = false;
    // Re-publish the strip entry: pi clears widgets at the session boundary
    // and the strip contract expects extensions to re-register on
    // session_start. The registry is empty here, so the entry is removed
    // (factory undefined) until a new job publishes it again.
    if (ctx.hasUI) publish(ctx.ui);
    if (isSingleTurnMode(ctx.mode)) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !WAKE_TOOLS.has(name)));
    }
    try {
      await pruneSpoolDir(agentStateDir("background-jobs"), { keep: liveSpoolPaths });
    } catch (error) {
      console.error(`[background-jobs] spool prune failed: ${(error as Error).message}`);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    shuttingDown = true;
    // Cancel every active job (SIGTERM their groups); the wake channel is
    // suppressed so shutdown never triggers new turns.
    for (const job of activeJobs(registry)) {
      void cancelJob(registry, job);
    }
  });

  pi.registerTool({
    name: "background",
    label: "Background Job",
    description:
      "Run a long-running shell command in the background and return immediately with a job id. The agent is automatically woken (new turn) when the command exits; if wake_on_pattern is set, it also wakes the first time output matches that regexp. The wake carries only the job id and exit code — never command output, which is read on demand with the jobs tool. Use this instead of the bash tool for anything long-running (test suites, builds, deploys, CI runs) so the turn doesn't block.",
    promptSnippet: "Run a long command in the background; get woken on completion",
    promptGuidelines: [
      "Use background for any command that may take more than a few seconds (test suites, builds, watch/serve, CI) instead of blocking on it. Also use it to launch multiple instances in parallel (fan out N jobs, harvest results with the jobs tool).",
      "After launching a background job, do NOT block waiting for it — keep working on something else in parallel, or end the turn if there is nothing else to do. Never sleep or poll for it: you are woken automatically on exit.",
      "Prefer the monitor tool over background when waiting for a CONDITION (CI going green, a file appearing, a log line) rather than a single command's exit.",
      "Command output is never auto-delivered: after a wake, read it with the jobs tool (action=tail).",
    ],
    parameters: BACKGROUND_PARAMETERS,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      lastUi = ctx.ui;
      if (isSingleTurnMode(ctx.mode)) return singleTurnErr();
      const command = String(params.command ?? "").trim();
      if (!command) return err("command_required", "command is required.");

      let wakeOnPattern: RegExp | undefined;
      const patternRaw = params.wake_on_pattern ? String(params.wake_on_pattern) : undefined;
      if (patternRaw) {
        try {
          wakeOnPattern = new RegExp(patternRaw);
        } catch (error) {
          return err(
            "invalid_pattern",
            `Invalid wake_on_pattern regexp: ${(error as Error).message}`,
          );
        }
      }

      const job = await startBackgroundJob({
        registry,
        command,
        cwd: params.cwd ? String(params.cwd) : ctx.cwd,
        label: params.label ? String(params.label) : undefined,
        env: (params.env as Record<string, string> | undefined) ?? undefined,
        wakeOnPattern,
        patternSource: patternRaw,
        spoolDir: agentStateDir("background-jobs"),
        events,
      });

      const patternNote = patternRaw
        ? `, or earlier the first time output matches /${patternRaw}/`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Started background job #${job.id} "${job.label}". You will be woken with the result when it exits${patternNote}; read the output with the jobs tool. Use jobs (action=cancel, jobId=${job.id}) to stop it.`,
          },
        ],
        details: { jobId: job.id, status: job.status, pid: job.pid },
      };
    },
  });

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Poll a shell command on an interval until a condition holds (exit_zero, exit_nonzero, stdout_matches, stdout_not_matches), then wake the agent with the result. Use instead of sleep/poll loops when waiting on a state: CI going green, a file appearing, a log line, a port opening. Non-blocking — the turn continues elsewhere.",
    promptSnippet: "Poll a command until a condition holds; get woken when satisfied",
    promptGuidelines: [
      "Use monitor instead of hand-rolled sleep/poll loops (sleep N in bash, over and over). It is non-blocking and wakes you when the condition holds or the timeout fires.",
      "The wake never carries command output — read it with the jobs tool (action=tail) after the wake.",
    ],
    parameters: MONITOR_PARAMETERS,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      lastUi = ctx.ui;
      if (isSingleTurnMode(ctx.mode)) return singleTurnErr();
      const command = String(params.command ?? "").trim();
      if (!command) return err("command_required", "command is required.");

      const satisfyOn = params.satisfy_on as
        | "exit_zero"
        | "exit_nonzero"
        | "stdout_matches"
        | "stdout_not_matches";
      const patternRaw = params.pattern ? String(params.pattern) : undefined;

      if ((satisfyOn === "stdout_matches" || satisfyOn === "stdout_not_matches") && !patternRaw) {
        return err("pattern_required", `satisfy_on=${satisfyOn} requires a pattern.`);
      }
      let pattern: RegExp | undefined;
      if (patternRaw) {
        try {
          pattern = new RegExp(patternRaw);
        } catch (error) {
          return err("invalid_pattern", `Invalid pattern regexp: ${(error as Error).message}`);
        }
      }

      const job = startMonitor({
        registry,
        command,
        cwd: ctx.cwd,
        satisfyOn,
        pattern,
        patternSource: patternRaw,
        intervalSeconds: params.interval_seconds ? Number(params.interval_seconds) : undefined,
        timeoutSeconds: params.timeout_seconds ? Number(params.timeout_seconds) : undefined,
        label: params.label ? String(params.label) : undefined,
        exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
        events,
      });

      return {
        content: [
          {
            type: "text",
            text: `Started monitor #${job.id} "${job.label}" — polling every ${job.intervalSeconds}s (timeout ${job.timeoutSeconds}s) until ${satisfyOn}${patternRaw ? ` matching /${patternRaw}/` : ""}. You will be woken when it is satisfied or times out; read the result with the jobs tool. Cancel with jobs (action=cancel, jobId=${job.id}).`,
          },
        ],
        details: {
          jobId: job.id,
          status: job.status,
          satisfyOn,
          intervalSeconds: job.intervalSeconds,
          timeoutSeconds: job.timeoutSeconds,
        },
      };
    },
  });

  pi.registerCommand("jobs", {
    description: "Open the background jobs panel",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      openJobsPanel(ctx.ui, registry);
    },
  });

  pi.registerTool({
    name: "jobs",
    label: "Jobs",
    description:
      "Manage background jobs and monitors: list them, inspect status, tail captured output, cancel a running job. Command output is never auto-delivered on wake — read it here on demand.",
    promptSnippet: "List / inspect / cancel background jobs and monitors",
    parameters: JOBS_PARAMETERS,
    outputSchema: JOBS_OUTPUT,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      lastUi = ctx.ui;
      return executeJobsAction({
        registry,
        action: String(params.action),
        jobId: params.jobId !== undefined ? Number(params.jobId) : undefined,
        lines: params.lines !== undefined ? Number(params.lines) : undefined,
        events,
      });
    },
  });
}
