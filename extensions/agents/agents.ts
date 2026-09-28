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
import { isProcessAlive } from "../../lib/presence-shards.ts";
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
import { assertWorkerId } from "./src/ids.ts";
import { SetupHookCancelled } from "./src/provision/hook.ts";
import {
  armAdoptedTimeout,
  finalizeWorker,
  killPidTree,
  type RunningWorker,
} from "./src/runner.ts";
import { DELEGATE_PARAMETERS, WORKERS_PARAMETERS } from "./src/schemas.ts";
import {
  listRecordFiles,
  loadWorker,
  loadWorkersFromBranch,
  migrateLegacyRegistry,
  persistWorkerRecord,
  persistWorkerRemoval,
  pruneStreams,
  pruneWorkerArtifacts,
  removeWorkerRecord,
  sweepWorkerArtifacts,
  updateRecordFile,
  WORKER_REMOVED_ENTRY,
  WORKER_RETENTION_MS,
  writeRecordFile,
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
  // Workers running under other (dead) sessions or restored by pi -c: this
  // session watches their pid and finalizes them from disk when they exit.
  // disarm clears the worker's re-armed hard timeout (a no-op for records
  // created before deadlines were persisted).
  const adopted = new Map<
    string,
    { pid: number; owned: boolean; timer: ReturnType<typeof setInterval>; disarm: () => void }
  >();

  /** Watch a running worker this session does not hold a RunningWorker for.
   *  Owned workers (restored by pi -c) get wakes on completion; foreign
   *  leftovers finalize silently into their record files. The record's
   *  persisted deadline is re-armed for the remaining time. */
  function adoptWorker(ctx: ExtensionContext, record: WorkerRecord, owned: boolean): boolean {
    if (record.pid === undefined || !isProcessAlive(record.pid)) return false;
    if (adopted.has(record.id)) return true;
    // The exit poller's interval is created below; the holder lets the
    // deadline's synchronous hook clear it before the kill.
    const poll: { timer?: ReturnType<typeof setInterval> } = {};
    // Durable hard timeout: when the persisted deadline elapses, the worker
    // is killed and terminalized as a timeout. beforeKill stops the exit
    // poller synchronously first — its natural-death inference
    // (completed/failed from the spool) must not win the race against the
    // deadline's terminal save.
    const disarm = armAdoptedTimeout(record, {
      cwd: lastCwd,
      beforeKill: () => {
        if (poll.timer !== undefined) clearInterval(poll.timer);
        adopted.delete(record.id);
      },
      ...(owned
        ? {
            events: makeEvents(ctx),
            onRecord: (finalized: WorkerRecord) => persistRecord(finalized),
          }
        : { onRecord: (finalized: WorkerRecord) => writeRecordFile(lastCwd, finalized) }),
      onSettled: () => {
        if (shutDown) return;
        publish(ctx).catch((error) => {
          console.error(`[agents] publish failed: ${(error as Error).message}`);
        });
      },
    });
    const timer = setInterval(() => {
      if (isProcessAlive(record.pid ?? -1)) return;
      void stopWatching(record.id).then(async (stillRunning) => {
        if (!stillRunning) return;
        await finalizeWorker({
          cwd: lastCwd,
          record,
          ...(owned ? { events: makeEvents(ctx) } : {}),
          onRecord: owned
            ? (finalized) => persistRecord(finalized)
            : (finalized) => writeRecordFile(lastCwd, finalized),
        });
        if (shutDown) return;
        publish(ctx).catch((error) => {
          console.error(`[agents] publish failed: ${(error as Error).message}`);
        });
      });
    }, 2_000);
    timer.unref?.();
    poll.timer = timer;
    adopted.set(record.id, { pid: record.pid, owned, timer, disarm });
    return true;
  }

  async function stopWatching(id: string): Promise<boolean> {
    const entry = adopted.get(id);
    if (entry === undefined) return false;
    clearInterval(entry.timer);
    entry.disarm();
    adopted.delete(id);
    const current = await loadWorker(lastCwd, id);
    return current === undefined || current.status === "running";
  }

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
   *  or another writer of this same session). Removal markers drop cached
   *  records; a newly persisted record can precede the branch snapshot. */
  function refreshFromBranch(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch() ?? [];
    const records = loadWorkersFromBranch(branch);
    for (const [id, record] of records) {
      state.branchWorkers.set(id, record);
    }
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== WORKER_REMOVED_ENTRY) continue;
      const id = (entry.data as { id?: unknown })?.id;
      if (typeof id === "string" && !records.has(id)) state.branchWorkers.delete(id);
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

  /**
   * Terminalize running leftovers whose worker process is dead (crashed
   * session, no one left watching). Status comes from the spool, so a
   * worker that actually finished is recorded as completed — with its
   * patch captured — instead of being marked failed by a blunt reconcile.
   */
  async function finalizeStaleWorkers(ctx: ExtensionContext, myIds: ReadonlySet<string>) {
    const sweepRecords = await listRecordFiles(ctx.cwd);
    for (const record of sweepRecords) {
      if (myIds.has(record.id) || record.status !== "running") continue;
      if (record.pid !== undefined && isProcessAlive(record.pid)) continue;
      await finalizeWorker({
        cwd: ctx.cwd,
        record,
        onRecord: (finalized) => writeRecordFile(ctx.cwd, finalized),
      });
    }
  }

  // --- delegate tool ---

  pi.registerTool({
    name: "delegate",
    label: "Delegate Worker",
    description:
      "Hand a bounded, self-contained task to a cheap-model worker Pi session with built-in file and shell tools routed through the OS sandbox (worker-sandbox). The worker gets its own context and its own git worktree by default. Set read_only for investigation-only workers that inspect the current workspace and produce no patch. Use for parallelizable investigation and well-specified implementation work; keep design decisions, integration, and review in this session.",
    promptGuidelines: [
      "Use delegate when a task is separable and well-specified: scouting a subsystem, mechanical edits across files, or trying an approach in isolation. Write the task so a fresh session with no conversation history can succeed: goal, files, constraints, verification.",
      "Do not delegate vague or judgment-heavy work; workers use the globally configured worker model. Escalate to the main session when a worker fails twice or the task turns ambiguous.",
      "After delegating, do not block: you are woken when the worker exits. Read its report with workers (action=status). Apply an implementation worker's patch with action=collect; read_only workers produce no patch.",
      "Worker slots free themselves: only a running worker holds a slot, and a worker in a terminal state (completed, failed, timeout, cancelled) consumes none — never cancel it. cancel stops a live process; remove deletes a terminal worker's record and artifacts; to relaunch, just delegate again.",
    ],
    parameters: DELEGATE_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      lastCwd = ctx.cwd;
      refreshFromBranch(ctx);
      if (signal?.aborted) throw new SetupHookCancelled("caller aborted the delegate");
      const plan = await planDelegate(params as DelegateParams, ctx);
      const { runningWorker, worktree } = await startDelegatedWorker({
        cwd: ctx.cwd,
        plan,
        state,
        events: makeEvents(ctx),
        persist: persistRecord,
        ...(signal !== undefined ? { signal } : {}),
      });

      if (params.wait === true) {
        // Attach before another await, then check the current signal state:
        // an abort during setup or running-record persistence cannot be lost.
        const cancel = () => {
          void runningWorker.cancel().catch((error) => {
            console.error(`[agents] worker cancel failed: ${(error as Error).message}`);
          });
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) cancel();
          await publish(ctx);
          const record = await runningWorker.done;
          state.running.delete(plan.workerId);
          await publish(ctx);
          return buildDelegateWaitedResponse(record);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      }

      await publish(ctx);
      return buildDelegateStartedResponse(
        plan,
        worktree,
        params.wait,
        runningWorker.record.provision,
      );
    },
  });

  // --- workers tool ---

  pi.registerTool({
    name: "workers",
    label: "Workers",
    description:
      "Manage delegated worker sessions: list this session's workers (optionally orphans left by ended sessions), read a worker's report (status), cancel a running worker, or collect an isolated worker's patch into the working tree (collect). Lifecycle: only running workers hold a delegate slot — workers in a terminal state consume none. cancel stops a live process; remove deletes a terminal worker's record, artifacts, and worktree; to relaunch, just delegate again.",
    parameters: WORKERS_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      lastCwd = ctx.cwd;
      refreshFromBranch(ctx);
      const action = params.action;

      if (action === "list") {
        const scope: WorkerListScope =
          params.scope === "orphans" || params.scope === "all" ? params.scope : "mine";
        if (scope === "mine") {
          return listWorkers({
            mine: [...mergedWorkers().values()],
            orphans: [],
            foreignLive: [],
            scope,
          });
        }
        // Finalize dead running leftovers so the listing reflects reality.
        await finalizeStaleWorkers(ctx, new Set(state.branchWorkers.keys()));
        const sweep = await sweepWorkerArtifacts(ctx.cwd, new Set(state.branchWorkers.keys()));
        return listWorkers({
          mine: [...mergedWorkers().values()],
          orphans: [...sweep.liveOrphans, ...sweep.terminalOrphans],
          foreignLive: sweep.foreignLive,
          scope,
        });
      }

      const id = typeof params.id === "string" ? params.id : "";
      if (!id.trim()) throw new Error(`workers ${String(action)} requires id.`);
      assertWorkerId(id);

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

      if (action === "tail") return tailWorkerStream(ctx.cwd, id, params.lines, record);
      if (action === "status") return workerStatusResponse(record);
      if (action === "cancel") {
        if (state.running.has(id)) {
          return cancelWorker({ running: state.running, publish: () => publish(ctx), id, record });
        }
        if (record.status !== "running") {
          return {
            content: [
              {
                type: "text",
                text: `Worker ${record.name} is already ${record.status}; its slot is free. Use action=remove to delete the record and artifacts, or delegate to start a new worker.`,
              },
            ],
            details: { worker: record },
          };
        }
        // Live worker without a local RunningWorker: adopted (pi -c) or an
        // orphan from an ended session. Kill by pid and finalize from disk.
        const parentAlive = record.parentPid !== undefined && isProcessAlive(record.parentPid);
        if (parentAlive) {
          throw new Error(
            `Worker ${id} belongs to another live session and cannot be cancelled here (parent pid ${record.parentPid}).`,
          );
        }
        if (record.pid !== undefined) await killPidTree(record.pid);
        const owned = state.branchWorkers.has(id);
        await stopWatching(id);
        const finalized = await finalizeWorker({
          cwd: ctx.cwd,
          record,
          statusOverride: "cancelled",
          ...(owned ? { events: makeEvents(ctx) } : {}),
          onRecord: owned
            ? (final) => persistRecord(final)
            : (final) => writeRecordFile(ctx.cwd, final),
        });
        await publish(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Worker ${record.name} (${id}) cancelled${owned ? "" : " (orphaned worker)"}.`,
            },
          ],
          details: { worker: finalized },
        };
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
        if (
          !state.branchWorkers.has(id) &&
          record.parentPid !== undefined &&
          isProcessAlive(record.parentPid)
        ) {
          throw new Error(
            `Worker ${id} belongs to another live session and cannot be removed here.`,
          );
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
        // Tombstone this session's own workers: the marker keeps the id
        // absent across reloads (transcript entries are immutable, so the
        // record entry alone would resurrect on every replay), and the
        // persistence queue orders it against a racing terminal save.
        // An orphan belongs to an ended session's transcript. This
        // session's marker cannot govern that replay, so it gets artifact
        // cleanup only.
        if (state.branchWorkers.has(id)) {
          await persistWorkerRemoval(
            (customType, data) => pi.appendEntry(customType, data),
            ctx.cwd,
            id,
          );
        } else {
          await removeWorkerRecord(ctx.cwd, id);
        }
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
    // The setup hook (the config-dir provision-worktree file) and worker
    // sandbox policy are project files; no bundled materialization or state
    // exclusions are needed. Provision run logs live in the global cache,
    // outside the repo.
    // One-time migration from the legacy shared registry to per-worker
    // artifact files (old records classify as orphans: no owner is known).
    await migrateLegacyRegistry(ctx.cwd);
    // Ownership: this session's transcript. Resume (`pi -c`/`-r`) restores
    // the records with the session.
    state.branchWorkers = loadWorkersFromBranch(ctx.sessionManager.getBranch() ?? []);
    // Own stuck-running records: salvage-finalize from disk (a worker that
    // finished while the session was away is recorded completed, patch
    // captured, and the user woken), or re-adopt live ones as watchers.
    for (const record of state.branchWorkers.values()) {
      if (record.status !== "running") continue;
      if (adoptWorker(ctx, record, true)) continue;
      await finalizeWorker({
        cwd: ctx.cwd,
        record,
        events: makeEvents(ctx),
        onRecord: (finalized) => persistRecord(finalized),
      });
    }
    // Terminalize dead leftovers BEFORE pruning: their spools are the
    // status-of-record for salvage.
    await finalizeStaleWorkers(ctx, new Set(state.branchWorkers.keys()));
    // Rétention : artifacts des records terminaux au-delà de 7 jours sortis,
    // puis spools orphelins. Spools of any still-running worker (branch or
    // record file) are protected — adoption may not have persisted its
    // record file yet.
    await pruneWorkerArtifacts(ctx.cwd);
    const protectRunning = new Set<string>(
      [...state.branchWorkers.values()].filter((w) => w.status === "running").map((w) => w.id),
    );
    for (const record of await listRecordFiles(ctx.cwd)) {
      if (record.status === "running") protectRunning.add(record.id);
    }
    await pruneStreams(ctx.cwd, Date.now(), protectRunning);
    // Keep worker state out of `git status`; best-effort outside repos.
    try {
      await excludeFromGit(ctx.cwd, `${projectStateRelative("workers")}/`);
      await excludeFromGit(ctx.cwd, `${projectStateRelative("worktrees")}/`);
      await excludeFromGit(ctx.cwd, projectStateRelative("provision-tmp-*"));
    } catch (error) {
      console.error(`[agents] git exclude failed: ${(error as Error).message}`);
    }
    // Janitor: terminalize dead leftovers (status inferred from their
    // spools), watch live orphans until they exit, and warn only about
    // workers still running from ended sessions — the one state that needs
    // the user's attention. Terminal leftovers are silent: discoverable
    // via workers (action=list, scope=orphans), drained by retention.
    const sweep = await sweepWorkerArtifacts(ctx.cwd, new Set(state.branchWorkers.keys()));
    for (const orphan of sweep.liveOrphans) adoptWorker(ctx, orphan, false);
    if (sweep.liveOrphans.length > 0 && ctx.hasUI) {
      const ids = sweep.liveOrphans
        .slice(0, 5)
        .map((w) => `${w.name} (${w.id})`)
        .join("; ");
      const more = sweep.liveOrphans.length > 5 ? ` … +${sweep.liveOrphans.length - 5} more` : "";
      ctx.ui.notify(
        `${sweep.liveOrphans.length} worker(s) from ended sessions are still running: ${ids}${more}. They finalize automatically when they exit; cancel with workers (action=cancel, id=…).`,
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
    for (const [id, entry] of adopted) {
      clearInterval(entry.timer);
      entry.disarm();
      adopted.delete(id);
      if (!entry.owned) continue;
      // An adopted (restored) worker is ours: cancel it on the way out,
      // same as locally spawned ones.
      const record = await loadWorker(lastCwd, id);
      if (record?.status === "running" && record.pid !== undefined) {
        await killPidTree(record.pid);
        await finalizeWorker({
          cwd: lastCwd,
          record,
          statusOverride: "cancelled",
          onRecord: (final) => persistRecord(final),
        });
      }
    }
    if (ctx.hasUI)
      setStripWidget(ctx.ui, "aboveEditor", {
        key: WORKERS_WIDGET_KEY,
        priority: WIDGET_PRIORITY_WORKERS,
        factory: undefined,
      });
  });
}
