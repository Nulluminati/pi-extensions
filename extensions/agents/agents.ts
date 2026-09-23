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
 * Worker state is session-scoped: the owning session's transcript carries
 * its worker records (restored by `pi -c`/`-r`), and project disk keeps only
 * per-worker artifact files plus a janitor that classifies leftovers from
 * ended sessions. Other live sessions' workers are never shown as one's own.
 *
 * Isolation is for coordination, not security: workers run with user
 * privileges. The worker model is selected globally through PI_WORKER_MODEL
 * or worker-model.json; keep orchestration and judgment in the main session.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "pi";
import { excludeFromGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { setStripWidget, WIDGET_PRIORITY_WORKERS } from "../../lib/widget-strip.ts";
import {
  cancelWorker,
  collectWorkerPatch,
  listWorkers,
  tailWorkerStream,
  type WorkerListScope,
  workerStatusResponse,
} from "./src/actions.ts";
import {
  buildDelegateStartedResponse,
  buildDelegateWaitedResponse,
  type DelegateParams,
  planDelegate,
  startDelegatedWorker,
  type WorkerSessionState,
} from "./src/delegate.ts";
import { AGENTS_STATE_EVENT, createWorkersWidget, WORKERS_WIDGET_KEY } from "./src/format.ts";
import type { RunningWorker } from "./src/runner.ts";
import { DELEGATE_PARAMETERS, WORKERS_PARAMETERS } from "./src/schemas.ts";
import {
  loadWorker,
  loadWorkersFromBranch,
  migrateLegacyRegistry,
  persistWorkerRecord,
  pruneStreams,
  pruneWorkerArtifacts,
  reconcileRunning,
  removeWorkerRecord,
  sweepWorkerArtifacts,
  updateRecordFile,
  WORKER_RETENTION_MS,
} from "./src/store.ts";
import type { WorkerEvents, WorkerRecord } from "./src/types.ts";
import { discardWorktree, removeWorktree, worktreePath } from "./src/worktree.ts";

// --- Constants ---

const WAKE_CUSTOM_TYPE = "agents:wake";

// --- Extension ---

export default async function agentsExtension(pi: ExtensionAPI) {
  const state: WorkerSessionState = {
    running: new Map<string, RunningWorker>(),
    branchWorkers: new Map<string, WorkerRecord>(),
    reserved: new Map<string, string>(),
  };
  let lastUi: ExtensionUIContext | undefined;
  // The worker cwd is fixed per session; publish and persistence need it
  // between tool calls and lifecycle events.
  let lastCwd = process.cwd();

  // --- Persistence ---

  /**
   * One worker state transition: transcript entry (ownership) plus artifact
   * record file (janitor), then the in-memory cache. Returns false when a
   * stale running snapshot lost to an already-durable terminal state; the
   * cache must not adopt it either.
   */
  async function persistRecord(record: WorkerRecord): Promise<boolean> {
    const persisted = await persistWorkerRecord(
      (customType, data) => pi.appendEntry(customType, data),
      lastCwd,
      record,
    );
    if (persisted) state.branchWorkers.set(record.id, record);
    return persisted;
  }

  // --- Publishing ---

  /** Live activity churn must not re-render (or disk-read) per event. */
  let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Once shutdown starts, worker events racing it (cancel-time terminal saves,
  // in-flight stream reads) must not publish or schedule refreshes anymore.
  let shutDown = false;

  /** The session's own records, with live children overlaid for freshness.
   *  Records past the retention window are excluded from views so the
   *  status-bar spend roll-up keeps its documented 7-day bound. */
  function mergedWorkers(): Map<string, WorkerRecord> {
    const now = Date.now();
    const workers = new Map<string, WorkerRecord>();
    for (const record of state.branchWorkers.values()) {
      if (record.status === "running") workers.set(record.id, record);
      else if (record.endedAt !== undefined && now - record.endedAt <= WORKER_RETENTION_MS) {
        workers.set(record.id, record);
      }
    }
    for (const [id, runningWorker] of state.running) {
      const known = workers.get(id);
      if (known === undefined || known.status === "running") workers.set(id, runningWorker.record);
    }
    return workers;
  }

  /** Adopt transcript entries added since the last refresh (pi -r restore,
   *  or another writer of this same session). The transcript is the truth;
   *  the live-activity overlay happens at render time. */
  function refreshFromBranch(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch() ?? [];
    for (const [id, record] of loadWorkersFromBranch(branch)) {
      state.branchWorkers.set(id, record);
    }
  }

  async function publish(ctx: ExtensionContext): Promise<void> {
    const workers = mergedWorkers();
    const runningCount = [...workers.values()].filter((w) => w.status === "running").length;
    // Roll up token/cost usage across this session's workers (running merged
    // with finished) for the status bar. Session-scoped by design: another
    // session's spend belongs to that session's status bar.
    let workerCostUsd = 0;
    let workerTokens = 0;
    for (const w of workers.values()) {
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
    const live = [...workers.values()]
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
      lastCwd = ctx.cwd;
      refreshFromBranch(ctx);
      const plan = await planDelegate(params as DelegateParams, ctx);
      const { runningWorker, worktree } = await startDelegatedWorker({
        cwd: ctx.cwd,
        plan,
        state,
        events: makeEvents(ctx),
        persist: persistRecord,
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
        state.running.delete(plan.workerId);
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
      "Manage delegated worker sessions: list this session's workers (optionally orphans left by ended sessions), read a worker's report (status), cancel a running worker, or collect an isolated worker's patch into the working tree (collect).",
    parameters: WORKERS_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      lastCwd = ctx.cwd;
      refreshFromBranch(ctx);
      const action = params.action;

      if (action === "list") {
        const scope: WorkerListScope =
          params.scope === "orphans" || params.scope === "all" ? params.scope : "mine";
        const sweep =
          scope === "mine"
            ? { orphans: [], foreignLive: [] }
            : await sweepWorkerArtifacts(ctx.cwd, new Set(state.branchWorkers.keys()));
        return listWorkers({
          mine: [...mergedWorkers().values()],
          orphans: sweep.orphans,
          foreignLive: sweep.foreignLive,
          scope,
        });
      }

      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) throw new Error(`workers ${String(action)} requires id.`);

      const live = state.running.get(id)?.record;
      const record: WorkerRecord | undefined =
        live ?? state.branchWorkers.get(id) ?? (await loadWorker(ctx.cwd, id));
      if (!record) {
        // No record file: the id may still own a leftover worktree (its
        // record was pruned or lost). Explicit cleanup of that worktree.
        if (action === "remove" && existsSync(worktreePath(ctx.cwd, id))) {
          await removeWorktree(ctx.cwd, id);
          const gone = !existsSync(worktreePath(ctx.cwd, id));
          return {
            content: [
              {
                type: "text",
                text: gone
                  ? `Leftover worktree for ${id} discarded (no worker record remained).`
                  : `Warning: worktree removal failed for ${id}; remove it manually at ${worktreePath(ctx.cwd, id)}.`,
              },
            ],
            details: { removed: gone ? id : undefined },
          };
        }
        throw new Error(`Unknown worker ${id}. Use action=list to see workers.`);
      }

      if (action === "tail") return tailWorkerStream(ctx.cwd, id, params.lines);
      if (action === "status") return workerStatusResponse(record);
      if (action === "cancel") {
        return cancelWorker({ running: state.running, publish: () => publish(ctx), id, record });
      }
      if (action === "collect") {
        // Own workers record the collect in this session's transcript;
        // orphans update their artifact record file instead.
        const persistCollected = state.branchWorkers.has(id)
          ? (updated: WorkerRecord) => persistRecord(updated).then(() => undefined)
          : (updated: WorkerRecord) =>
              updateRecordFile(ctx.cwd, id, () => updated).then(() => undefined);
        return collectWorkerPatch(
          ctx.cwd,
          id,
          record,
          { apply: params.apply, cleanup: params.cleanup },
          persistCollected,
        );
      }
      if (action === "remove") {
        if (record.status === "running") {
          throw new Error(`Worker ${id} is still running; cancel it before removing.`);
        }
        // Deliberate abandonment: discard the worktree and branch too — but
        // never when the patch file is gone and the worktree would be the
        // only remaining copy of the worker's changes.
        const worktreeOutcome = await discardWorktree(ctx.cwd, record);
        if (worktreeOutcome === "kept") {
          throw new Error(
            `Patch file ${record.patchPath} is missing; keeping worktree ${record.worktree} so the worker's changes are not lost.`,
          );
        }
        await removeWorkerRecord(ctx.cwd, id);
        state.branchWorkers.delete(id);
        await publish(ctx);
        const worktreeNote =
          worktreeOutcome === "removed"
            ? " Worktree and branch discarded."
            : worktreeOutcome === "failed"
              ? ` Warning: worktree removal failed; remove it manually at ${worktreePath(ctx.cwd, id)}.`
              : "";
        return {
          content: [
            {
              type: "text",
              text: `Worker ${id} removed: record, stream spool and patch deleted.${worktreeNote}`,
            },
          ],
          details: { removed: id },
        };
      }

      throw new Error(`Unknown workers action: ${String(action)}`);
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    lastCwd = ctx.cwd;
    // Event contexts carry a usable ui surface: capture it so the widget is
    // restored on session_start (reload) before any tool call has run.
    if (ctx.hasUI) lastUi = ctx.ui;
    // One-time migration from the legacy shared registry to per-worker
    // artifact files (old records classify as orphans: no owner is known).
    await migrateLegacyRegistry(ctx.cwd);
    // Ownership: this session's transcript. Resume (`pi -c`/`-r`) restores
    // the records with the session.
    state.branchWorkers = loadWorkersFromBranch(ctx.sessionManager.getBranch() ?? []);
    // Reconcile the session's own stuck-running records (dead worker pid)
    // and persist the healed states.
    for (const changed of reconcileRunning(state.branchWorkers.values())) {
      await persistRecord(changed);
    }
    // Rétention : artifacts des records terminaux au-delà de 7 jours sortis,
    // puis spools orphelins (running conservés).
    await pruneWorkerArtifacts(ctx.cwd);
    await pruneStreams(ctx.cwd);
    // Keep worker state out of `git status`; best-effort outside repos.
    try {
      await excludeFromGit(ctx.cwd, `${projectStateRelative("workers")}/`);
      await excludeFromGit(ctx.cwd, `${projectStateRelative("worktrees")}/`);
    } catch (error) {
      console.error(`[agents] git exclude failed: ${(error as Error).message}`);
    }
    // Janitor: leftovers from ended sessions are reported, never deleted
    // silently; they stay collectable via workers (action=collect), and
    // remove discards their worktrees.
    const sweep = await sweepWorkerArtifacts(ctx.cwd, new Set(state.branchWorkers.keys()));
    const leftovers = sweep.orphans.length + sweep.unownedWorktrees.length;
    if (leftovers > 0 && ctx.hasUI) {
      const items = [
        ...sweep.orphans.map((w) => `${w.name} (${w.id}, ${w.status})`),
        ...sweep.unownedWorktrees.map((wid) => `${wid} (unowned worktree)`),
      ];
      const ids = items.slice(0, 5).join("; ");
      const more = items.length > 5 ? ` … +${items.length - 5} more` : "";
      const withWorktrees =
        sweep.orphans.filter((w) => w.worktree !== undefined).length +
        sweep.unownedWorktrees.length;
      const worktreeNote =
        withWorktrees > 0 ? ` ${withWorktrees} still hold worktree(s) on disk.` : "";
      ctx.ui.notify(
        `${leftovers} orphaned worker artifact(s) from ended sessions: ${ids}${more}.${worktreeNote} Inspect with workers (action=list, scope=orphans); collect or remove them explicitly — remove also discards leftover worktrees.`,
        "warning",
      );
    }
    await publish(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shutDown = true;
    if (activityRefreshTimer) {
      clearTimeout(activityRefreshTimer);
      activityRefreshTimer = undefined;
    }
    state.reserved.clear();
    for (const [id, worker] of state.running) {
      state.running.delete(id);
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
