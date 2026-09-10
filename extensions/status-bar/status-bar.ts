/**
 * Status Bar Extension
 *
 * A Starship-inspired two-line footer that replaces the default Pi footer,
 * plus an input editor wrapped in the same rounded accent modal frame the
 * voice/handoff overlays use, with the model + thinking level shown in the
 * title (top border).
 *
 *  Footer line 1 (static session info):
 *    model/provider, thinking level (color-coded, with a live activity dot),
 *    working directory (last path component + icon), git branch + status
 *    indicator block (!?+$»=✘$↑↓⇕), and a right-aligned context usage bar
 *    with the token breakdown (↑↓↗↘), turn count, and cost.
 *
 *  Footer line 2 (transient events):
 *    third-party extension statuses published via ctx.ui.setStatus(). Omitted
 *    entirely when empty.
 *
 *  Editor:
 *    The default Pi editor is wrapped in a rounded accent modal frame
 *    (renderModalFrame, shared with the voice/handoff overlays). The title
 *    (top border) shows the main model + thinking level (+ flex badge when
 *    capable), then a "/" separator and the small model label in grey.
 *
 * Toggle: /statusbar
 */

import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
  removeEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { loadSmallModelConfig, resolveSmallModelConfigPath } from "../../lib/small-model.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath as resolveWorkerModelConfigPathLib,
} from "../../lib/worker-model.ts";
import {
  FLEX_EVENT,
  GOAL_STATE_EVENT,
  GONDOLIN_VM_EVENT,
  ICON_COLOR,
  PLAN_MODE_EVENT,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
} from "./src/constants.ts";
import { getModelLabel, PolishedEditor } from "./src/editor.ts";
import { buildFooterLines } from "./src/footer.ts";
import { parseGitStatus } from "./src/git.ts";
import type { State } from "./src/types.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./src/constants.ts";
export {
  buildEditorMetaSegments,
  type EditorModalFrameInput,
  renderEditorModalFrame,
} from "./src/editor.ts";

// --- Extension ---

export default async function statusBarExtension(pi: ExtensionAPI) {
  const state: State = {
    enabled: true,
    turnCount: 0,
    thinkingLevel: "none",
    smallModelLabel: "",
    workerModelLabel: "",
    goalRunning: false,
    goalIteration: 0,
    goalCap: null,
    gondolinVm: null,
    gitBranch: null,
    gitStatus: null,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextUsage: undefined,
    lastHandle: null,
    flexOn: false,
    flexCapable: false,
    planModeActive: false,
  };

  let getBranch: () => any[] = () => [];
  let currentCwd = "";
  let smallModelWatcher: FSWatcher | undefined;
  let smallModelWatchDebounce: ReturnType<typeof setTimeout> | undefined;
  let workerModelWatcher: FSWatcher | undefined;
  let workerModelWatchDebounce: ReturnType<typeof setTimeout> | undefined;

  // Track a running goal so the editor frame can show a "Goal" badge in its
  // top-right cell. Subscribed at load time rather than in session_start: the
  // goal extension announces its state during its own session_start handler,
  // which may run before this extension's handler registers a
  // session_start-scoped listener, and the state would be missed on first
  // load. Load-time subscriptions are registered before any session events
  // dispatch.
  pi.events.on(
    GOAL_STATE_EVENT,
    (payload: { status: string | null; iteration?: number; maxIterations?: number }) => {
      state.goalRunning = payload.status === "active";
      state.goalIteration = payload.status === "active" ? (payload.iteration ?? 0) : 0;
      state.goalCap = payload.status === "active" ? (payload.maxIterations ?? null) : null;
      state.lastHandle?.requestRender();
      editorRequestRender?.();
    },
  );

  function setFooter(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;

    // Close previous footer
    if (state.lastHandle) {
      state.lastHandle.close();
      state.lastHandle = null;
    }

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const unsub = footerData.onBranchChange(async () => {
        state.gitBranch = footerData.getGitBranch();
        // Await so the subsequent render reflects the new branch's status, not
        // a stale snapshot from before the refresh completed.
        await refreshGitStatus();
        tui.requestRender();
      });

      const handle = {
        requestRender: () => tui.requestRender(),
        close: () => unsub(),
      };
      state.lastHandle = handle;

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          return buildFooterLines(state, ctx, theme, footerData, width);
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    if (state.lastHandle) {
      state.lastHandle.close();
      state.lastHandle = null;
    }
    ctx.ui.setFooter(undefined);
  }

  // --- Editor: install the visual frame below behavior layers such as voice
  // input handling, so either extension can be enabled or removed independently.
  const editorLayerId = "status-bar";
  let editorRequestRender: (() => void) | undefined;

  function installEditor(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
    if (hasEditorFactoryLayer(current, editorLayerId)) return;

    const installedEditorFactory = installEditorFactoryLayer(
      current,
      editorLayerId,
      0,
      (_parent, tui, theme, keybindings) => {
        const editorTui = tui as ConstructorParameters<typeof PolishedEditor>[0];
        editorRequestRender = () => editorTui.requestRender();
        return new PolishedEditor(
          editorTui,
          theme,
          keybindings,
          ctx.ui.theme,
          () => getModelLabel(ctx),
          () => state.smallModelLabel,
          () => pi.getThinkingLevel() ?? "none",
          () => ({ on: state.flexOn, capable: state.flexCapable }),
          () => (state.planModeActive ? "warning" : undefined),
          () => {
            const parts: string[] = [];
            if (state.planModeActive) parts.push(ctx.ui.theme.fg("warning", "Plan Mode"));
            if (state.goalRunning) {
              const capLabel = state.goalCap && state.goalCap > 0 ? `/${state.goalCap}` : "";
              parts.push(ctx.ui.theme.fg("mdHeading", `Goal ${state.goalIteration}${capLabel}`));
            }
            return parts.length > 0 ? parts.join(ctx.ui.theme.fg("dim", " · ")) : undefined;
          },
        );
      },
    );
    ctx.ui.setEditorComponent(installedEditorFactory);
  }

  function restoreEditor(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
    const restored = removeEditorFactoryLayer(current, editorLayerId);
    if (restored !== current) ctx.ui.setEditorComponent(restored);
    editorRequestRender = undefined;
  }

  /**
   * Snapshot context-window usage into state. O(conversation) to compute, so
   * the footer render reads the cache instead of calling ctx.getContextUsage()
   * on every keystroke. Refreshed on session start, turn boundaries, new
   * messages, and model switches (a new model can change the context window
   * and thus the percentage).
   */
  function refreshContextUsage(ctx: ExtensionCommandContext): void {
    state.contextUsage = ctx.getContextUsage();
  }

  /**
   * Read the global small model config and cache its "provider/model" label for
   * the editor meta line. Cleared when no small model is configured. Read on
   * session_start and turn_start; the small model rarely changes, and a fresh
   * read each turn picks up `/smallmodel` changes without a file watcher.
   */
  function refreshSmallModel(): void {
    try {
      const loaded = loadSmallModelConfig();
      state.smallModelLabel = `${loaded.config.provider}/${loaded.config.model}`;
    } catch {
      state.smallModelLabel = "";
    }
  }

  /**
   * Watch the global small-model config file so the editor title updates the
   * instant `/smallmodel` (or an external edit) changes it — without waiting
   * for the next turn. Mirrors the small-model extension's own watcher.
   */
  function startSmallModelWatch(): void {
    stopSmallModelWatch();
    stopWorkerModelWatch();
    let configPath: string;
    try {
      configPath = resolveSmallModelConfigPath();
    } catch {
      return;
    }
    const configDirectory = dirname(configPath);
    try {
      smallModelWatcher = watch(configDirectory, (_event, filename) => {
        if (filename && filename.toString() !== basename(configPath)) return;
        if (smallModelWatchDebounce) clearTimeout(smallModelWatchDebounce);
        smallModelWatchDebounce = setTimeout(() => {
          smallModelWatchDebounce = undefined;
          refreshSmallModel();
          refreshWorkerModel();
          editorRequestRender?.();
        }, 25);
      });
    } catch {
      smallModelWatcher = undefined;
    }
  }

  function stopSmallModelWatch(): void {
    if (smallModelWatchDebounce) {
      clearTimeout(smallModelWatchDebounce);
      smallModelWatchDebounce = undefined;
    }
    smallModelWatcher?.close();
    smallModelWatcher = undefined;
  }

  function refreshWorkerModel(): void {
    try {
      const loaded = loadWorkerModelConfig();
      state.workerModelLabel = `${loaded.config.provider}/${loaded.config.model}`;
    } catch {
      state.workerModelLabel = "";
    }
  }

  /** Watch the global worker-model config file (mirrors the small-model watcher). */
  function startWorkerModelWatch(): void {
    stopWorkerModelWatch();
    let configPath: string;
    try {
      configPath = resolveWorkerModelConfigPathLib();
    } catch {
      return;
    }
    const configDirectory = dirname(configPath);
    try {
      workerModelWatcher = watch(configDirectory, (_event, filename) => {
        if (filename && filename.toString() !== basename(configPath)) return;
        if (workerModelWatchDebounce) clearTimeout(workerModelWatchDebounce);
        workerModelWatchDebounce = setTimeout(() => {
          workerModelWatchDebounce = undefined;
          refreshWorkerModel();
          editorRequestRender?.();
        }, 25);
      });
    } catch {
      workerModelWatcher = undefined;
    }
  }

  function stopWorkerModelWatch(): void {
    if (workerModelWatchDebounce) {
      clearTimeout(workerModelWatchDebounce);
      workerModelWatchDebounce = undefined;
    }
    workerModelWatcher?.close();
    workerModelWatcher = undefined;
  }

  function accumulateTokenUsage(): void {
    const tu = state.tokenUsage;
    tu.input = 0;
    tu.output = 0;
    tu.cacheRead = 0;
    tu.cacheWrite = 0;
    tu.cost = 0;

    for (const entry of getBranch()) {
      if (
        entry.type === "message" &&
        "message" in entry &&
        (entry.message as any).role === "assistant"
      ) {
        const usage = (entry.message as any).usage;
        if (usage) {
          tu.input += usage.input ?? 0;
          tu.output += usage.output ?? 0;
          tu.cacheRead += usage.cacheRead ?? 0;
          tu.cacheWrite += usage.cacheWrite ?? 0;
          tu.cost += usage.cost?.total ?? 0;
        }
      }
    }
  }

  async function refreshGitStatus(): Promise<void> {
    if (!currentCwd) return;
    try {
      const [statusResult, stashResult] = await Promise.all([
        pi.exec("git", ["status", "--porcelain=2", "--branch"], {
          cwd: currentCwd,
          timeout: 3000,
        }),
        pi
          .exec("git", ["rev-parse", "--verify", "--quiet", "refs/stash"], {
            cwd: currentCwd,
            timeout: 3000,
          })
          .catch(() => ({ stdout: "", stderr: "", code: 1, killed: false })),
      ]);
      if (statusResult.code === 0) {
        const hasStash = stashResult.stdout.trim().length > 0;
        state.gitStatus = parseGitStatus(statusResult.stdout, hasStash);
      } else {
        state.gitStatus = null;
      }
    } catch {
      state.gitStatus = null;
    }
  }

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    state.turnCount = 0;
    state.thinkingLevel = pi.getThinkingLevel() ?? "none";
    state.tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    currentCwd = ctx.cwd;
    getBranch = () => ctx.sessionManager.getBranch();
    accumulateTokenUsage();
    refreshSmallModel();
    refreshWorkerModel();
    refreshContextUsage(ctx as ExtensionCommandContext);

    // Install the UI components synchronously, before any async work, so the
    // polished editor frame and footer are present for the first paint. Git
    // branch/status land in state and surface on the next render once the
    // refresh below resolves (the footer also subscribes to branch changes).
    if (state.enabled) {
      setFooter(ctx as ExtensionCommandContext);
      installEditor(ctx as ExtensionCommandContext);
      ctx.ui.setStatus(
        STATUS_KEY,
        formatStatusLine(ctx.ui.theme, {
          icon: STATUS_ICON,
          prefix: "Status Bar",
          text: "enabled",
          iconColor: ICON_COLOR,
          textColor: TEXT_COLOR,
        }),
      );
      // Re-check after a tick: another extension that loads later may replace
      // our editor. If so, re-install so the frame stays in place.
      setTimeout(() => {
        if (!state.enabled) return;
        const current = (ctx as ExtensionCommandContext).ui.getEditorComponent() as
          | EditorFactory
          | undefined;
        if (!hasEditorFactoryLayer(current, editorLayerId)) {
          installEditor(ctx as ExtensionCommandContext);
        }
      }, 0);
    }

    // Track a running goal so the editor frame can show a "Goal" badge in
    // its top-right cell (subscribed at load time; see above).

    // Subscribe to Neuralwatt flex state changes to render the flex badge next
    // to the thinking level. Keeps the metadata line in sync with the toggle
    // without coupling the status-bar editor to Neuralwatt's internals.
    pi.events.on(FLEX_EVENT, (flex: { flexOn: boolean; flexCapable: boolean }) => {
      state.flexOn = flex.flexOn;
      state.flexCapable = flex.flexCapable;
      state.lastHandle?.requestRender();
      editorRequestRender?.();
    });

    // Tint the editor frame while the plan extension is in plan mode. The
    // plan extension publishes on the pi.events bus (see plan:mode-change);
    // re-render so the frame picks up the new border color immediately.
    pi.events.on(PLAN_MODE_EVENT, (payload: { mode: string }) => {
      state.planModeActive = payload.mode === "plan";
      state.lastHandle?.requestRender();
      editorRequestRender?.();
    });

    // Track the Gondolin sandbox VM so line 1 can show the workspace segment
    // ("with WS <id>") after the working directory. The gondolin extension
    // publishes on the pi.events bus (see gondolin:vm-state).
    pi.events.on(
      GONDOLIN_VM_EVENT,
      (payload: { state: "starting" | "ready" | "stopping" | "stopped"; vmId?: string }) => {
        state.gondolinVm =
          payload.state === "stopped"
            ? null
            : {
                state: payload.state,
                ...(payload.vmId !== undefined ? { vmId: payload.vmId } : {}),
              };
        state.lastHandle?.requestRender();
      },
    );

    // Watch the small-model config so the editor title reflects `/smallmodel`
    // changes immediately rather than on the next turn.
    startSmallModelWatch();
    startWorkerModelWatch();

    await refreshGitStatus();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopSmallModelWatch();
    stopWorkerModelWatch();
    clearFooter(ctx as ExtensionCommandContext);
    restoreEditor(ctx as ExtensionCommandContext);
  });

  pi.on("turn_start", async (_event, ctx) => {
    state.turnCount++;
    refreshSmallModel();
    refreshWorkerModel();
    refreshContextUsage(ctx as ExtensionCommandContext);
    if (state.lastHandle) state.lastHandle.requestRender();
    editorRequestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    accumulateTokenUsage();
    await refreshGitStatus();
    refreshContextUsage(ctx as ExtensionCommandContext);
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("message_end", async (_event, ctx) => {
    accumulateTokenUsage();
    refreshContextUsage(ctx as ExtensionCommandContext);
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("model_select", async (_event, ctx) => {
    refreshContextUsage(ctx as ExtensionCommandContext);
    if (state.lastHandle) state.lastHandle.requestRender();
    editorRequestRender?.();
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    state.thinkingLevel = event.level;
    if (state.lastHandle) state.lastHandle.requestRender();
    editorRequestRender?.();
  });

  // --- Command ---

  pi.registerCommand("statusbar:toggle", {
    description: "Toggle the Starship-inspired status bar footer",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      state.enabled = !state.enabled;

      if (state.enabled) {
        state.thinkingLevel = pi.getThinkingLevel() ?? "none";
        currentCwd = ctx.cwd;
        getBranch = () => ctx.sessionManager.getBranch();
        accumulateTokenUsage();
        refreshSmallModel();
        refreshWorkerModel();
        refreshContextUsage(ctx);
        await refreshGitStatus();
        setFooter(ctx);
        installEditor(ctx);
        ctx.ui.setStatus(
          STATUS_KEY,
          formatStatusLine(ctx.ui.theme, {
            icon: STATUS_ICON,
            prefix: "Status Bar",
            text: "enabled",
            iconColor: ICON_COLOR,
            textColor: TEXT_COLOR,
          }),
        );
        ctx.ui.notify("Status bar enabled", "info");
      } else {
        clearFooter(ctx);
        restoreEditor(ctx);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify("Status bar disabled, default footer restored", "info");
      }
    },
  });
}
