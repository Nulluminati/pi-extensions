/**
 * Agents Extension
 *
 * Multi-agent workflows: delegate bounded tasks to cheap-model worker Pi
 * sessions. Workers run `pi --mode json --no-session` as detached child
 * processes with their own messenger identity, optionally inside an isolated
 * git worktree (their own branch) so parallel workers never collide on
 * files. On completion the parent session is woken with a trusted message
 * (ids and status words only); worker reports and patches are read/collected
 * via the workers tool.
 *
 * Isolation is for coordination, not security: workers run with user
 * privileges. The worker model is selected globally through PI_WORKER_MODEL
 * or worker-model.json; keep orchestration and judgment in the main session.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "pi";
import { excludeFromGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { setStripWidget, WIDGET_PRIORITY_WORKERS } from "../../lib/widget-strip.ts";
import {
  cancelWorker,
  collectWorkerPatch,
  listWorkers,
  removeWorker,
  tailWorkerStream,
  workerStatusResponse,
} from "./src/actions.ts";
import {
  buildDelegateStartedResponse,
  buildDelegateWaitedResponse,
  type DelegateParams,
  planDelegate,
  startDelegatedWorker,
} from "./src/delegate.ts";
import { AGENTS_STATE_EVENT, createWorkersWidget, WORKERS_WIDGET_KEY } from "./src/format.ts";
import type { RunningWorker } from "./src/runner.ts";
import { DELEGATE_PARAMETERS, WORKERS_PARAMETERS } from "./src/schemas.ts";
import { loadWorker, loadWorkers, pruneStreams, pruneWorkerRecords } from "./src/store.ts";
import type { WorkerEvents, WorkerRecord } from "./src/types.ts";

// --- Constants ---

const WAKE_CUSTOM_TYPE = "agents:wake";

// --- Extension ---

export default async function agentsExtension(pi: ExtensionAPI) {
  const running = new Map<string, RunningWorker>();
  let lastUi: ExtensionUIContext | undefined;

  // --- Publishing ---

  /** Live activity churn must not re-render (or disk-read) per event. */
  let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Once shutdown starts, worker events racing it (cancel-time terminal saves,
  // in-flight stream reads) must not publish or schedule refreshes anymore.
  let shutDown = false;

  async function publish(ctx: ExtensionContext): Promise<void> {
    const workers = await loadWorkers(ctx.cwd);
    // Live running-map records win over disk: they carry the freshest stream
    // activity snapshot (activity is never persisted per update).
    for (const [id, runningWorker] of running) {
      if (workers[id]?.status === "running") workers[id] = runningWorker.record;
    }
    const runningCount = Object.values(workers).filter((w) => w.status === "running").length;
    // Roll up token/cost usage across every worker on record (running merged
    // with finished) for the status bar. Worker spend is project state; the
    // status bar renders it separately from this session's own counters.
    // Scope: project-lifetime spend BOUNDED BY THE 7-DAY RETENTION — records
    // past the window are pruned from the registry on session_start
    // (pruneWorkerRecords), so the roll-up never covers more than the last
    // seven days of finished work plus the running workers.
    let workerCostUsd = 0;
    let workerTokens = 0;
    for (const w of Object.values(workers)) {
      if (w.usage === undefined) continue;
      workerCostUsd += w.usage.costUsd;
      workerTokens +=
        w.usage.inputTokens +
        w.usage.outputTokens +
        w.usage.cacheReadTokens +
        w.usage.cacheWriteTokens;
    }
    pi.events.emit(AGENTS_STATE_EVENT, {
      running: runningCount,
      workerCostUsd,
      workerTokens,
    });
    if (!ctx.hasUI || !lastUi?.setWidget) return;
    const live = Object.values(workers)
      .filter((w) => w.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    setStripWidget(lastUi, "aboveEditor", {
      key: WORKERS_WIDGET_KEY,
      priority: WIDGET_PRIORITY_WORKERS,
      factory: live.length > 0 ? createWorkersWidget(() => live) : undefined,
    });
  }

  function makeEvents(ctx: ExtensionContext): WorkerEvents {
    return {
      wake(message) {
        try {
          pi.sendMessage(
            {
              customType: WAKE_CUSTOM_TYPE,
              content: [{ type: "text", text: message }],
              display: false,
              details: { source: "agents", trusted: true },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch (err) {
          console.error(`[agents] wake failed: ${(err as Error).message}`);
        }
      },
      notify(level, message) {
        try {
          if (ctx.hasUI) ctx.ui.notify(message, level);
        } catch {
          // ctx can go stale after session replacement; drop late notifications.
        }
      },
      onChange() {
        if (shutDown) return;
        publish(ctx).catch((error) => {
          console.error(`[agents] publish failed: ${(error as Error).message}`);
        });
      },
      onActivity() {
        if (shutDown) return;
        // Throttle widget refreshes: many stream events can arrive per second.
        if (activityRefreshTimer) return;
        activityRefreshTimer = setTimeout(() => {
          activityRefreshTimer = undefined;
          publish(ctx).catch((error) => {
            console.error(`[agents] publish failed: ${(error as Error).message}`);
          });
        }, 500);
      },
    };
  }

  // --- delegate tool ---

  pi.registerTool({
    name: "delegate",
    label: "Delegate Worker",
    description:
      "Hand a bounded, self-contained task to a cheap-model worker Pi session with built-in file and shell tools routed through Gondolin. The worker gets its own context and, outside plan mode, its own git worktree by default. Planning workers are read-only and report-only. Use for parallelizable investigation and well-specified implementation work; keep design decisions, integration, and review in this session.",
    promptGuidelines: [
      "Use delegate when a task is separable and well-specified: scouting a subsystem, mechanical edits across files, or trying an approach in isolation. Write the task so a fresh session with no conversation history can succeed: goal, files, constraints, verification.",
      "Do not delegate vague or judgment-heavy work; workers use the globally configured worker model. Escalate to the main session when a worker fails twice or the task turns ambiguous.",
      "After delegating, do not block: you are woken when the worker exits. Read its report with workers (action=status). Apply an implementation worker's patch with action=collect; planning workers are read-only and produce no patch.",
    ],
    parameters: DELEGATE_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      const plan = await planDelegate(params as DelegateParams, ctx);
      const { runningWorker, worktree } = await startDelegatedWorker({
        cwd: ctx.cwd,
        plan,
        running,
        events: makeEvents(ctx),
      });
      await publish(ctx);

      if (params.wait === true) {
        // A cancelled turn aborts this tool call; cancel the worker too so it
        // does not stay pending until the hard timeout.
        signal?.addEventListener(
          "abort",
          () => {
            void runningWorker.cancel();
          },
          { once: true },
        );
        const record = await runningWorker.done;
        running.delete(plan.workerId);
        await publish(ctx);
        return buildDelegateWaitedResponse(record);
      }

      return buildDelegateStartedResponse(plan, worktree, params.wait);
    },
  });

  // --- workers tool ---

  pi.registerTool({
    name: "workers",
    label: "Workers",
    description:
      "Manage delegated worker sessions: list all workers, read a worker's report (status), cancel a running worker, or collect an isolated worker's patch into the working tree (collect).",
    parameters: WORKERS_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      const action = params.action;

      if (action === "list") return listWorkers(ctx.cwd);

      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) throw new Error(`workers ${String(action)} requires id.`);

      const live = running.get(id)?.record;
      const record: WorkerRecord | undefined = live ?? (await loadWorker(ctx.cwd, id));
      if (!record) throw new Error(`Unknown worker ${id}. Use action=list to see workers.`);

      if (action === "tail") return tailWorkerStream(ctx.cwd, id, params.lines);
      if (action === "status") return workerStatusResponse(record);
      if (action === "cancel") {
        return cancelWorker({ running, publish: () => publish(ctx), id, record });
      }
      if (action === "collect") {
        return collectWorkerPatch(ctx.cwd, id, record, {
          apply: params.apply,
          cleanup: params.cleanup,
        });
      }
      if (action === "remove") return removeWorker(ctx.cwd, id, () => publish(ctx));

      throw new Error(`Unknown workers action: ${String(action)}`);
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Event contexts carry a usable ui surface: capture it so the widget is
    // restored on session_start (reload) before any tool call has run.
    if (ctx.hasUI) lastUi = ctx.ui;
    // Rétention : records terminaux au-delà de 7 jours sortis du registre
    // avec leurs artifacts (stream, patch), puis spools orphelins (running
    // conservés). Le roll-up de spend de la status bar est donc un
    // project-lifetime borné à cette fenêtre de rétention.
    await pruneWorkerRecords(ctx.cwd);
    await pruneStreams(ctx.cwd);
    // Keep worker state out of `git status`; best-effort outside repos.
    try {
      await excludeFromGit(ctx.cwd, `${projectStateRelative("workers")}/`);
      await excludeFromGit(ctx.cwd, `${projectStateRelative("worktrees")}/`);
    } catch (error) {
      console.error(`[agents] git exclude failed: ${(error as Error).message}`);
    }
    // loadWorkers heals stuck-running records on read (dead pid → failed),
    // so loading the registry reconciles orphans left by a crashed parent.
    await loadWorkers(ctx.cwd);
    await publish(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shutDown = true;
    if (activityRefreshTimer) {
      clearTimeout(activityRefreshTimer);
      activityRefreshTimer = undefined;
    }
    for (const [id, worker] of running) {
      running.delete(id);
      await worker.cancel();
    }
    if (ctx.hasUI)
      setStripWidget(ctx.ui, "aboveEditor", {
        key: WORKERS_WIDGET_KEY,
        priority: WIDGET_PRIORITY_WORKERS,
        factory: undefined,
      });
  });
}
