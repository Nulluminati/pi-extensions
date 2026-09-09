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
 * privileges. Default worker model is a cheap fast model (configurable via
 * PI_WORKER_MODEL) — keep orchestration and judgment in the main session.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "pi";
import { resolveWorkerExtensions } from "../../lib/worker-extensions.ts";
import { resolveWorkerModelSpec } from "../../lib/worker-model.ts";
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
      "Hand a bounded, self-contained task to a cheap-model worker Pi session. The worker gets its own context (and by default its own git worktree + branch); it reports back and, when isolated, produces a patch you collect with the workers tool. Use for parallelizable investigation and well-specified implementation work; keep design decisions, integration, and review in this session.",
    promptGuidelines: [
      "Use delegate when a task is separable and well-specified: scouting a subsystem, mechanical edits across files, or trying an approach in isolation. Write the task so a fresh session with no conversation history can succeed: goal, files, constraints, verification.",
      "Do not delegate vague or judgment-heavy work; workers are cheap models. Escalate to the main session (or a stronger model via the model parameter) when a worker fails twice or the task turns ambiguous.",
      "After delegating, do not block: you are woken when the worker exits. Read its report with the workers tool (action=status) and apply its patch with action=collect.",
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

      const explicitModel =
        typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
      // No hardcoded default: resolution is env -> config file, with "main"
      // inheriting the session model. Unconfigured delegates fail descriptively.
      const { model } = await resolveWorkerModelSpec(explicitModel, ctx);
      const timeoutMs =
        typeof params.timeout_seconds === "number" && params.timeout_seconds > 0
          ? params.timeout_seconds * 1000
          : envTimeoutMs();

      let worktree: { path: string; branch: string } | undefined;
      const wantIsolate = params.isolate !== false;
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
      // worker-extensions.json -> default set. messenger is always included;
      // denylisted workflow extensions are rejected outright.
      const requestedExtensions = Array.isArray(params.extensions)
        ? params.extensions.map(String)
        : undefined;
      const resolvedExtensions = resolveWorkerExtensions(requestedExtensions, {
        extensionsRoot: fileURLToPath(new URL("../../extensions/", import.meta.url)),
      });
      const extensionPaths = resolvedExtensions.map((extension) => extension.path);
      const sandbox = resolvedExtensions.some((extension) => extension.name === "gondolin");

      const runningWorker = startWorker({
        cwd: ctx.cwd,
        task,
        model,
        name,
        timeoutMs,
        workerId,
        extensionPaths,
        sandbox,
        ...(worktree !== undefined ? { worktree } : {}),
        events: makeEvents(ctx),
        onRecord: (worker) => saveWorker(ctx.cwd, worker),
      });
      running.set(workerId, runningWorker);
      // Persist the running record immediately so concurrency limits,
      // duplicate-name checks, and the workers list see it.
      await saveWorker(ctx.cwd, runningWorker.record);
      await publish(ctx);

      const isolateNote = worktree
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
