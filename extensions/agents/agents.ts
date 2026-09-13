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

import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "pi";
import { resolveWorkerExtensions } from "../../lib/worker-extensions.ts";
import { resolveWorkerModelSpec } from "../../lib/worker-model.ts";
import { isPlanModeActive } from "../plan/src/state.ts";
import {
  AGENTS_STATE_EVENT,
  formatWorkerList,
  formatWorkerStatus,
  WORKERS_WIDGET_KEY,
  widgetLines,
} from "./src/format.ts";
import { type RunningWorker, startWorker } from "./src/runner.ts";
import { DELEGATE_PARAMETERS, WORKERS_PARAMETERS } from "./src/schemas.ts";
import { generateWorkerId, loadWorker, loadWorkers, saveWorker } from "./src/store.ts";
import type { WorkerEvents, WorkerRecord } from "./src/types.ts";
import { applyPatch, createWorktree, isGitRepo, removeWorktree } from "./src/worktree.ts";

// --- Constants ---

const WAKE_CUSTOM_TYPE = "agents:wake";
const DEFAULT_TIMEOUT_MS = 900_000;

function envMaxWorkers(): number {
  const parsed = Number.parseInt(process.env.PI_MAX_WORKERS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function envTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.PI_WORKER_TIMEOUT_S ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_TIMEOUT_MS;
}

// --- Extension ---

export default async function agentsExtension(pi: ExtensionAPI) {
  const running = new Map<string, RunningWorker>();
  let lastUi: ExtensionUIContext | undefined;

  // --- Publishing ---

  async function publish(ctx: ExtensionContext): Promise<void> {
    const workers = await loadWorkers(ctx.cwd);
    const runningCount = Object.values(workers).filter((w) => w.status === "running").length;
    pi.events.emit(AGENTS_STATE_EVENT, { running: runningCount });
    if (!ctx.hasUI || !lastUi?.setWidget) return;
    const live = Object.values(workers)
      .filter((w) => w.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    lastUi.setWidget(WORKERS_WIDGET_KEY, widgetLines(live));
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
        void publish(ctx);
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastUi = ctx.ui;
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error("delegate requires task.");
      const workerId = generateWorkerId();

      const workers = await loadWorkers(ctx.cwd);
      const activeCount = Object.values(workers).filter((w) => w.status === "running").length;
      const maxWorkers = envMaxWorkers();
      if (activeCount >= maxWorkers) {
        throw new Error(
          `Worker limit reached (${activeCount}/${maxWorkers}). Wait for a worker to finish or raise PI_MAX_WORKERS.`,
        );
      }

      // The global environment/config selection is authoritative. Individual
      // delegate calls cannot silently substitute another model.
      const { model, thinkingLevel } = await resolveWorkerModelSpec();
      const timeoutMs =
        typeof params.timeout_seconds === "number" && params.timeout_seconds > 0
          ? params.timeout_seconds * 1000
          : envTimeoutMs();
      const parentPlanning = isPlanModeActive((ctx.sessionManager.getBranch() ?? []) as unknown[]);

      let worktree: { path: string; branch: string } | undefined;
      // Read-only planning workers inspect the parent's current files through
      // Gondolin and never need a branch or patch. Avoid changing git metadata
      // merely to perform research during plan mode.
      const wantIsolate = !parentPlanning && params.isolate !== false;
      if (wantIsolate) {
        if (!(await isGitRepo(ctx.cwd))) {
          if (params.isolate === true) {
            throw new Error("isolate=true requires a git repository.");
          }
        } else {
          worktree = await createWorktree(ctx.cwd, workerId);
        }
      }

      const name =
        typeof params.name === "string" && params.name.trim() ? params.name.trim() : workerId;
      const duplicate = Object.values(workers).some(
        (w) => w.name === name && w.status === "running",
      );
      if (duplicate) throw new Error(`A running worker named "${name}" already exists.`);

      // Worker extension allowlist: delegate param -> PI_WORKER_EXTENSIONS ->
      // worker-extensions.json -> default set. Messenger and Gondolin are
      // mandatory; denylisted workflow extensions are rejected outright.
      const requestedExtensions = Array.isArray(params.extensions)
        ? params.extensions.map(String)
        : undefined;
      const resolvedExtensions = resolveWorkerExtensions(requestedExtensions, {
        extensionsRoot: fileURLToPath(new URL("../../extensions/", import.meta.url)),
      });
      // Every worker routes built-in file and shell tools through Gondolin.
      // Planning workers additionally load the headless plan gate, which
      // reduces active tools to the research allowlist and enforces read-only Bash.
      const extensionPaths = resolvedExtensions.map((extension) => extension.path);
      if (parentPlanning) {
        extensionPaths.push(fileURLToPath(new URL("../plan/plan.ts", import.meta.url)));
      }
      const sandbox = true;
      const readOnly = parentPlanning;

      const runningWorker = startWorker({
        cwd: ctx.cwd,
        task,
        model,
        thinkingLevel,
        name,
        timeoutMs,
        workerId,
        extensionPaths,
        sandbox,
        readOnly,
        ...(worktree !== undefined ? { worktree } : {}),
        events: makeEvents(ctx),
        onRecord: (worker) => saveWorker(ctx.cwd, worker),
      });
      running.set(workerId, runningWorker);
      // Persist the running record immediately so concurrency limits,
      // duplicate-name checks, and the workers list see it.
      await saveWorker(ctx.cwd, runningWorker.record);
      await publish(ctx);

      const isolateNote = parentPlanning
        ? "Read-only planning worker: Gondolin is enforced and workspace mutation is blocked."
        : worktree
          ? `Isolated in worktree ${worktree.branch}. Its patch is collected with workers (action=collect, id=${workerId}).`
          : "Not isolated: the worker edits this working tree directly.";
      const waitNote = params.wait === true ? "" : " You will be woken when it exits.";

      if (params.wait === true) {
        const record = await runningWorker.done;
        running.delete(workerId);
        await publish(ctx);
        return {
          content: [{ type: "text", text: formatWorkerStatus(record) }],
          details: { worker: record },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Worker ${name} (${workerId}) started on ${model}. ${isolateNote}${waitNote}`,
          },
        ],
        details: { workerId, name, model, worktree: worktree?.path },
      };
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

      if (action === "list") {
        const workers = await loadWorkers(ctx.cwd);
        const sorted = Object.values(workers).sort((a, b) => a.startedAt - b.startedAt);
        return {
          content: [{ type: "text", text: formatWorkerList(sorted) }],
          details: { count: sorted.length },
        };
      }

      const id = typeof params.id === "string" ? params.id.trim() : "";
      if (!id) throw new Error(`workers ${String(action)} requires id.`);

      const live = running.get(id)?.record;
      const record: WorkerRecord | undefined = live ?? (await loadWorker(ctx.cwd, id));
      if (!record) throw new Error(`Unknown worker ${id}. Use action=list to see workers.`);

      if (action === "status") {
        return {
          content: [{ type: "text", text: formatWorkerStatus(record) }],
          details: { worker: record },
        };
      }

      if (action === "cancel") {
        const runningWorker = running.get(id);
        if (!runningWorker) {
          throw new Error(
            record.status === "running"
              ? `Worker ${id} belongs to another session or an earlier run and cannot be cancelled here (pid ${record.pid ?? "?"}).`
              : `Worker ${id} is already ${record.status}.`,
          );
        }
        await runningWorker.cancel();
        running.delete(id);
        await publish(ctx);
        return {
          content: [{ type: "text", text: `Worker ${record.name} (${id}) cancelled.` }],
          details: { worker: runningWorker.record },
        };
      }

      if (action === "collect") {
        if (!record.patchPath) {
          throw new Error(
            `Worker ${id} has no patch (only isolated workers produce patches, after finishing).`,
          );
        }
        if (record.collectedAt !== undefined) {
          throw new Error(`Worker ${id}'s patch was already collected.`);
        }
        const shouldApply = params.apply !== false;
        const shouldCleanup = params.cleanup !== false;
        const lines: string[] = [];
        if (shouldApply) {
          try {
            await applyPatch(ctx.cwd, record.patchPath);
            lines.push(`Applied patch ${record.patchPath} to the working tree.`);
          } catch (err) {
            throw new Error(
              `Patch apply failed: ${(err as Error).message}. The patch file is kept at ${record.patchPath}; resolve conflicts manually if needed.`,
            );
          }
        } else {
          lines.push(`Patch left unapplied at ${record.patchPath}.`);
        }
        if (shouldCleanup && record.worktree) {
          // Never remove a worktree whose changes are not durably captured:
          // if the patch file is gone, removal would destroy the only copy.
          const patchMissing = await access(record.patchPath).then(
            () => false,
            () => true,
          );
          if (patchMissing) {
            throw new Error(
              `Patch file ${record.patchPath} is missing; keeping worktree ${record.worktree} so the worker's changes are not lost.`,
            );
          }
          await removeWorktree(ctx.cwd, id);
          lines.push("Worktree and branch removed.");
        }
        record.collectedAt = Date.now();
        await saveWorker(ctx.cwd, record);
        return { content: [{ type: "text", text: lines.join(" ") }], details: { worker: record } };
      }

      throw new Error(`Unknown workers action: ${String(action)}`);
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Workers from a previous process are gone; reconcile records whose pid
    // is no longer alive so the registry reflects reality.
    const workers = await loadWorkers(ctx.cwd);
    for (const worker of Object.values(workers)) {
      if (worker.status !== "running" || worker.pid === undefined) continue;
      let alive = false;
      try {
        process.kill(worker.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) {
        worker.status = "failed";
        worker.error = "worker process is gone (session ended before completion)";
        worker.endedAt = Date.now();
        await saveWorker(ctx.cwd, worker);
      }
    }
    await publish(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const [id, worker] of running) {
      running.delete(id);
      await worker.cancel();
    }
    if (ctx.hasUI) ctx.ui.setWidget(WORKERS_WIDGET_KEY, undefined);
  });
}
