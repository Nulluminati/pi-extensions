/**
 * Missions Extension
 *
 * Durable missions: long-lived objectives with a task graph, checkpoints,
 * decisions, and a budget, persisted as JSON under `<cwd>/.pi/missions/` so
 * they survive restarts. The `mission` tool lets the agent create and
 * maintain the record; `reconcile` re-runs done tasks' verification commands
 * and flags regressions so the record can be checked against reality.
 *
 * Design note: missions deliberately does NOT inject per-turn context (that
 * would break the provider prompt-cache prefix). The tool's prompt guidelines
 * tell the agent to consult mission status when working on mission tasks.
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  formatMissionStatus,
  formatMissionSummaries,
  formatReconcileReport,
  formatStatus,
  MISSION_STATE_EVENT,
  MISSION_STATUS_KEY,
  widgetLines,
} from "./src/format.ts";
import {
  addCheckpoint,
  addDecision,
  addSpend,
  addTask,
  createMission,
  reconcileMission,
  requireOpen,
  setBudget,
  setStatus,
  setTaskVerification,
  updateTask,
  type VerificationRunner,
} from "./src/ops.ts";
import { MISSION_PARAMETERS } from "./src/schemas.ts";
import {
  generateMissionId,
  listMissionSummaries,
  loadActiveMission,
  loadMission,
  saveMission,
  setActiveMissionId,
} from "./src/storage.ts";
import type { Mission } from "./src/types.ts";

const execAsync = promisify(execCb);

// --- Extension ---

export default async function missionsExtension(pi: ExtensionAPI) {
  /** Cached active mission; kept in sync with disk on every tool call. */
  let active: Mission | undefined;

  // --- Verification runner ---

  const runner: VerificationRunner = {
    async run(command, cwd) {
      try {
        await execAsync(command, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 });
        return { ok: true, output: "verification command passed" };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
        return { ok: false, output: output || "verification command failed" };
      }
    },
  };

  // --- Publishing ---

  function publish(ctx: ExtensionContext): void {
    pi.events.emit(MISSION_STATE_EVENT, {
      active: active !== undefined,
      status: active?.status ?? null,
      title: active?.title ?? null,
    });
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(MISSION_STATUS_KEY, formatStatus(ctx.ui.theme, active));
    ctx.ui.setWidget("missions", widgetLines(active));
  }

  async function reloadActive(ctx: ExtensionContext): Promise<Mission | undefined> {
    active = await loadActiveMission(ctx.cwd);
    publish(ctx);
    return active;
  }

  function requireActive(): Mission {
    if (!active) {
      throw new Error(
        "No active mission. Use the mission tool (action=create) to create one, or action=switch to select one.",
      );
    }
    return active;
  }

  async function persist(ctx: ExtensionContext, mission: Mission): Promise<void> {
    await saveMission(ctx.cwd, mission);
    active = mission;
    publish(ctx);
  }

  // --- Tool ---

  pi.registerTool({
    name: "mission",
    label: "Mission",
    description:
      "Create and maintain a durable mission: an objective with a task graph, checkpoints, decisions, and budget, persisted across restarts. Prefer this over ad-hoc plan files when the user asks for a mission, roadmap, or multi-session effort with tracked tasks and verification.",
    promptGuidelines: [
      "Use mission to record durable multi-session work: create the mission, break it into tasks with dependsOn ordering, attach verification commands to tasks so reconcile can catch regressions, and log checkpoints and decisions as work progresses.",
      "When a mission is active, run mission (action=status) before starting work on its tasks and after finishing each one.",
    ],
    parameters: MISSION_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;

      if (action === "create") {
        const title = (params.title ?? "").trim();
        const objective = (params.objective ?? "").trim();
        if (!title) throw new Error("create requires title.");
        if (!objective) throw new Error("create requires objective.");
        if (await loadActiveMission(ctx.cwd)) {
          throw new Error(
            "An active mission already exists. Complete, abort, or switch missions before creating a new one.",
          );
        }
        const mission = createMission(generateMissionId(), title, objective, {
          ...(params.maxIterations !== undefined ? { maxIterations: params.maxIterations } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
        });
        await saveMission(ctx.cwd, mission);
        await setActiveMissionId(ctx.cwd, mission.id);
        active = mission;
        publish(ctx);
        return {
          content: [
            { type: "text", text: `Created ${mission.id}. ${formatMissionStatus(mission)}` },
          ],
          details: { missionId: mission.id },
        };
      }

      if (action === "list") {
        const summaries = await listMissionSummaries(ctx.cwd);
        return {
          content: [{ type: "text", text: formatMissionSummaries(summaries) }],
          details: { count: summaries.length },
        };
      }

      if (action === "switch") {
        const id = (params.id ?? "").trim();
        if (!id) throw new Error("switch requires id.");
        const mission = await loadMission(ctx.cwd, id);
        if (!mission) throw new Error(`No mission found with id ${id}.`);
        await setActiveMissionId(ctx.cwd, mission.id);
        active = mission;
        publish(ctx);
        return {
          content: [
            { type: "text", text: `Switched to ${mission.id}. ${formatMissionStatus(mission)}` },
          ],
          details: { missionId: mission.id },
        };
      }

      if (action === "status") {
        await reloadActive(ctx);
        const mission = requireActive();
        return {
          content: [{ type: "text", text: formatMissionStatus(mission) }],
          details: { missionId: mission.id, status: mission.status },
        };
      }

      // Everything below operates on the active mission.
      const mission = requireActive();

      switch (action) {
        case "task_add": {
          requireOpen(mission);
          const title = (params.taskTitle ?? "").trim();
          if (!title) throw new Error("task_add requires taskTitle.");
          const task = addTask(mission, {
            title,
            ...(params.dependsOn !== undefined ? { dependsOn: params.dependsOn } : {}),
            ...(params.owner !== undefined ? { owner: params.owner } : {}),
            ...(params.verification !== undefined ? { verification: params.verification } : {}),
          });
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: `Added ${task.id}: ${task.title}` }],
            details: { taskId: task.id },
          };
        }
        case "task_update": {
          const taskId = (params.taskId ?? "").trim();
          if (!taskId) throw new Error("task_update requires taskId.");
          const task = updateTask(mission, {
            taskId,
            ...(params.status !== undefined ? { status: params.status } : {}),
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
            ...(params.owner !== undefined ? { owner: params.owner } : {}),
          });
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: `${task.id} is now ${task.status}.` }],
            details: { taskId: task.id, status: task.status },
          };
        }
        case "task_verify": {
          const taskId = (params.taskId ?? "").trim();
          if (!taskId) throw new Error("task_verify requires taskId.");
          const task = setTaskVerification(mission, taskId, params.verification);
          await persist(ctx, mission);
          return {
            content: [
              {
                type: "text",
                text: task.verification
                  ? `${task.id} verification: ${task.verification.command}`
                  : `${task.id} verification cleared.`,
              },
            ],
            details: { taskId: task.id },
          };
        }
        case "checkpoint": {
          const label = (params.label ?? "").trim();
          if (!label) throw new Error("checkpoint requires label.");
          const summary = (params.summary ?? "").trim();
          if (!summary) throw new Error("checkpoint requires summary.");
          const { id } = addCheckpoint(mission, label, summary, params.commit);
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: `Checkpoint ${id} recorded.` }],
            details: { checkpointId: id },
          };
        }
        case "decision": {
          const text = (params.text ?? "").trim();
          if (!text) throw new Error("decision requires text.");
          addDecision(mission, text);
          await persist(ctx, mission);
          return { content: [{ type: "text", text: "Decision recorded." }], details: {} };
        }
        case "set_budget": {
          const budget = setBudget(mission, {
            ...(params.maxIterations !== undefined ? { maxIterations: params.maxIterations } : {}),
            ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
          });
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: `Budget: ${JSON.stringify(budget)}` }],
            details: { budget },
          };
        }
        case "spend": {
          if (params.iterations === undefined && params.tokens === undefined) {
            throw new Error("spend requires iterations and/or tokens.");
          }
          const { overBudget, spent } = addSpend(mission, params.iterations, params.tokens);
          await persist(ctx, mission);
          return {
            content: [
              {
                type: "text",
                text: overBudget
                  ? `Spend recorded: ${JSON.stringify(spent)}. OVER BUDGET — report this to the user.`
                  : `Spend recorded: ${JSON.stringify(spent)}.`,
              },
            ],
            details: { spent, overBudget },
          };
        }
        case "set_status": {
          const status = params.missionStatus;
          if (!status) throw new Error("set_status requires missionStatus.");
          setStatus(mission, status);
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: `Mission is now ${status}.` }],
            details: { status },
          };
        }
        case "reconcile": {
          const report = await reconcileMission(mission, ctx.cwd, runner);
          await persist(ctx, mission);
          return {
            content: [{ type: "text", text: formatReconcileReport(report) }],
            details: { report },
          };
        }
        default:
          throw new Error(`Unknown mission action: ${String(action)}`);
      }
    },
  });

  // --- Commands ---

  pi.registerCommand("missions", {
    description: "List all missions for this project",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const summaries = await listMissionSummaries(ctx.cwd);
      ctx.ui.notify(formatMissionSummaries(summaries), "info");
    },
  });

  pi.registerCommand("mission:status", {
    description: "Show the active mission's full status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const mission = await reloadActive(ctx);
      if (!mission) {
        ctx.ui.notify(
          "No active mission. Use the mission tool (action=create) to start one.",
          "info",
        );
        return;
      }
      ctx.ui.notify(formatMissionStatus(mission), "info");
    },
  });

  pi.registerCommand("mission:reconcile", {
    description:
      "Re-run verification commands for all done tasks in the active mission and flag regressions",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      const mission = await reloadActive(ctx);
      if (!mission) {
        ctx.ui.notify("No active mission to reconcile.", "info");
        return;
      }
      ctx.ui.notify("Reconciling mission (running verification commands)…", "info");
      const report = await reconcileMission(mission, ctx.cwd, runner);
      await persist(ctx, mission);
      ctx.ui.notify(
        formatReconcileReport(report),
        report.regressed.length > 0 ? "warning" : "info",
      );
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    await reloadActive(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Mission state lives on disk; just clear session UI.
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(MISSION_STATUS_KEY, undefined);
    ctx.ui.setWidget("missions", undefined);
  });
}
