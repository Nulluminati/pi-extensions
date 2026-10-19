/**
 * Status Bar Extension
 *
 * Responsive framed panels replace the default Pi footer. The input editor
 * uses the rounded accent modal frame shared with voice/handoff overlays.
 * The model + thinking level live in the editor title (top border).
 *
 *  Footer panels:
 *    Workspace: working directory, Git branch and status (!?+$»=✘$↑↓⇕).
 *    Context: usage bar, context window and token breakdown (↑↓↗↘).
 *    Session: turn count, cost, unread mail and delegated-worker spend.
 *    Panels sit side by side when space permits, otherwise stack and wrap.
 *
 *  Transient events:
 *    Third-party statuses published via ctx.ui.setStatus() follow the panels.
 *    The footer omits these rows when empty.
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
import { sumSessionUsage } from "../../lib/session-usage.ts";
import { loadSmallModelConfig, resolveSmallModelConfigPath } from "../../lib/small-model.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath as resolveWorkerModelConfigPathLib,
} from "../../lib/worker-model.ts";
import {
  APPROVAL_MODE_EVENT,
  FLEX_EVENT,
  GOAL_STATE_EVENT,
  ICON_COLOR,
  MESSENGER_STATE_EVENT,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
  WORKERS_STATE_EVENT,
} from "./src/constants.ts";
import { getModelLabel, PolishedEditor } from "./src/editor.ts";
import { buildFooterLines } from "./src/footer.ts";
import { parseGitStatus } from "./src/git.ts";
import type { State } from "./src/types.ts";

export {
  ICON_COLOR,
  ICON_SMALL_MODEL,
  ICON_WORKER_MODEL,
  STATUS_ICON,
  TEXT_COLOR,
} from "./src/constants.ts";
export {
  buildEditorMetaSegments,
  type EditorModalFrameInput,
  renderEditorModalFrame,
} from "./src/editor.ts";

// --- Config file watching ---

/** A live config-file watch: the directory watcher (undefined when the
 *  directory could not be watched) plus the matching stop logic. */
interface ConfigWatch {
  watcher: FSWatcher | undefined;
  stop: () => void;
}

/**
 * Watch the directory containing `configPath`, filtered to its basename, and
 * call `onStable` once 25ms after the last event (a single save often
 * arrives as several). Shared by the small-model and worker-model watchers.
 */
function watchConfigFile(configPath: string, onStable: () => void): ConfigWatch {
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(dirname(configPath), (_event, filename) => {
      if (filename && filename.toString() !== basename(configPath)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        onStable();
      }, 25);
    });
    // Async watcher errors (watched directory removed, resource limits)
    // arrive as `error` events; with no listener they crash the session.
    // Watching is best-effort — the bar keeps refreshing on other events.
    watcher?.on("error", (error) => {
      console.debug("[status-bar] config watcher failed:", error);
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }
  return {
    watcher,
    stop() {
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      watcher?.close();
      watcher = undefined;
    },
  };
}

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
    gitBranch: null,
    gitStatus: null,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextUsage: undefined,
    lastHandle: null,
    flexOn: false,
    flexCapable: false,
    approvalModeOff: false,
    unreadMail: 0,
    workerCostUsd: 0,
    workerTokens: 0,
  };

  let getBranch: () => any[] = () => [];
  let currentCwd = "";
  let smallModelWatch: ConfigWatch | undefined;
  let workerModelWatch: ConfigWatch | undefined;

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

  // Track unread messenger mail so line 1 can show an "✉ N" segment in its
  // right block. Subscribed at load time rather than in session_start, for
  // the same reason as the goal subscription above: the messenger extension
  // publishes its state during its own session_start handler, which may run
  // before this extension's session_start-scoped listeners exist, and the
  // announcement would be missed on first load. Like goalRunning, unreadMail
  // is not reset on session boundaries — the messenger re-announces on every
  // session_start, and resetting here could clobber that announcement.
  pi.events.on(MESSENGER_STATE_EVENT, (payload: { name: string | null; unread: number }) => {
    state.unreadMail = payload.unread;
    state.lastHandle?.requestRender();
  });

  // Worker spend roll-up from the workers extension. Like unreadMail, this is
  // event-owned state: the workers extension re-announces on its lifecycle
  // events, so no session-boundary reset.
  pi.events.on(
    WORKERS_STATE_EVENT,
    (payload: { running: number; workerCostUsd?: number; workerTokens?: number }) => {
      state.workerCostUsd = payload.workerCostUsd ?? 0;
      state.workerTokens = payload.workerTokens ?? 0;
      state.lastHandle?.requestRender();
    },
  );

  // The approval gate announces its state on session_start. Subscribe before
  // that event so the editor never misses the initial enabled state.
  pi.events.on(APPROVAL_MODE_EVENT, (payload: { enabled: boolean }) => {
    state.approvalModeOff = !payload.enabled;
    state.lastHandle?.requestRender();
    editorRequestRender?.();
  });

  // Track Neuralwatt flex state so the editor frame can show the flex badge
  // next to the thinking level. Subscribed at load time rather than in
  // session_start: the neuralwatt extension emits flex state during its own
  // session_start handler, which may run before this extension's
  // session_start-scoped listeners exist, and re-subscribing per session would
  // stack a duplicate listener on every session start.
  pi.events.on(FLEX_EVENT, (flex: { flexOn: boolean; flexCapable: boolean }) => {
    state.flexOn = flex.flexOn;
    state.flexCapable = flex.flexCapable;
    state.lastHandle?.requestRender();
    editorRequestRender?.();
  });

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
          return buildFooterLines(state, ctx, theme, footerData, width, tui.terminal?.rows ?? 24);
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

  function editorHistorySessionId(ctx: ExtensionCommandContext): string {
    return ctx.sessionManager.getSessionId();
  }

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
          () => (state.approvalModeOff ? "warning" : undefined),
          () => {
            const parts: string[] = [];
            if (state.approvalModeOff) parts.push(ctx.ui.theme.fg("warning", "Approval Mode off"));
            if (state.goalRunning) {
              const capLabel = state.goalCap && state.goalCap > 0 ? `/${state.goalCap}` : "";
              parts.push(ctx.ui.theme.fg("mdHeading", `Goal ${state.goalIteration}${capLabel}`));
            }
            return parts.length > 0 ? parts.join(ctx.ui.theme.fg("dim", " · ")) : undefined;
          },
          () => state.workerModelLabel,
          editorHistorySessionId(ctx),
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
   * for the next turn.
   */
  function startSmallModelWatch(): void {
    stopSmallModelWatch();
    let configPath: string;
    try {
      configPath = resolveSmallModelConfigPath();
    } catch {
      return;
    }
    smallModelWatch = watchConfigFile(configPath, () => {
      refreshSmallModel();
      refreshWorkerModel();
      editorRequestRender?.();
    });
  }

  function stopSmallModelWatch(): void {
    smallModelWatch?.stop();
    smallModelWatch = undefined;
  }

  function refreshWorkerModel(): void {
    try {
      const loaded = loadWorkerModelConfig();
      state.workerModelLabel = `${loaded.config.provider}/${loaded.config.model}`;
    } catch {
      state.workerModelLabel = "";
    }
  }

  /** Watch the global worker-model config file so its label stays live too. */
  function startWorkerModelWatch(): void {
    stopWorkerModelWatch();
    let configPath: string;
    try {
      configPath = resolveWorkerModelConfigPathLib();
    } catch {
      return;
    }
    workerModelWatch = watchConfigFile(configPath, () => {
      refreshWorkerModel();
      editorRequestRender?.();
    });
  }

  function stopWorkerModelWatch(): void {
    workerModelWatch?.stop();
    workerModelWatch = undefined;
  }

  function accumulateTokenUsage(): void {
    state.tokenUsage = sumSessionUsage(getBranch());
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
    description: "Toggle the responsive status panels and framed editor",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      state.enabled = !state.enabled;

      if (state.enabled) {
        state.thinkingLevel = pi.getThinkingLevel() ?? "none";
        currentCwd = ctx.cwd;
        getBranch = () => ctx.sessionManager.getBranch();
        accumulateTokenUsage();
        refreshSmallModel();
        refreshWorkerModel();
        startSmallModelWatch();
        startWorkerModelWatch();
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
