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

// --- Imports ---
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import { excludeFromGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";
import { setStripWidget, WIDGET_PRIORITY_MISSIONS } from "../../lib/widget-strip.ts";
import {
  type ActiveMissionRef,
  createExecVerificationRunner,
  executeMissionAction,
  loadSessionActiveMission,
  MISSION_ACTIVE_ENTRY_TYPE,
  type MissionActionDeps,
} from "./src/actions.ts";
import {
  createMissionWidget,
  formatMissionStatus,
  formatMissionSummaries,
  formatReconcileReport,
  formatStatus,
  MISSION_STATE_EVENT,
  MISSION_STATUS_KEY,
  MISSION_WIDGET_KEY,
} from "./src/format.ts";
import { reconcileMission } from "./src/ops.ts";
import { MISSION_PARAMETERS } from "./src/schemas.ts";
import { listMissionSummaries, saveMission } from "./src/storage.ts";
import type { Mission } from "./src/types.ts";

// --- Extension ---

export default async function missionsExtension(pi: ExtensionAPI) {
  /** Cached active mission; kept in sync with disk on every tool call. */
  let active: Mission | undefined;

  const runner = createExecVerificationRunner();

  // --- Active-mission pointer ---

  // The cache above is consulted by every tool call; `record` writes the
  // session-transcript entry that makes the pointer survive restarts.
  const activeMission: ActiveMissionRef = {
    get: () => active,
    set: (mission) => {
      active = mission;
    },
    record: (id) => {
      pi.appendEntry(MISSION_ACTIVE_ENTRY_TYPE, { id });
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
    setStripWidget(ctx.ui, "aboveEditor", {
      key: MISSION_WIDGET_KEY,
      priority: WIDGET_PRIORITY_MISSIONS,
      factory: active ? createMissionWidget(() => active) : undefined,
    });
  }

  async function reloadActive(ctx: ExtensionContext): Promise<Mission | undefined> {
    active = await loadSessionActiveMission(ctx);
    publish(ctx);
    return active;
  }

  async function persist(ctx: ExtensionContext, mission: Mission): Promise<void> {
    await saveMission(ctx.cwd, mission);
    active = mission;
    publish(ctx);
  }

  const deps: MissionActionDeps = {
    mission: activeMission,
    publish,
    persist,
    reload: reloadActive,
    runner,
  };

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
      return executeMissionAction(deps, params, ctx);
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
    // Keep project-local state out of `git status`; best-effort outside repos.
    try {
      await excludeFromGit(ctx.cwd, `${projectStateRelative("missions")}/`);
    } catch (error) {
      console.error(`[missions] git exclude failed: ${(error as Error).message}`);
    }
    await reloadActive(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Mission state lives on disk; just clear session UI.
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(MISSION_STATUS_KEY, undefined);
    setStripWidget(ctx.ui, "aboveEditor", {
      key: MISSION_WIDGET_KEY,
      priority: WIDGET_PRIORITY_MISSIONS,
      factory: undefined,
    });
  });
}
