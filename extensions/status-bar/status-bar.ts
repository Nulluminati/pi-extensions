/**
 * Status Bar Extension
 *
 * A Starship-inspired two-line footer that replaces the default Pi footer,
 * plus a polished input editor that frames the prompt box in grey and shows
 * the model + thinking level inside the frame (Opencode/zentui-style).
 *
 *  Footer line 1 (static session info):
 *    model/provider, thinking level (color-coded, with a live activity dot),
 *    working directory (last path component + icon), git branch + status
 *    indicator block (!?+$»=✘$↑↓⇕), and a right-aligned context usage bar
 *    with the token breakdown (↑↓↗↘), turn count, and cost.
 *
 *  Footer line 2 (transient events):
 *    active/completed tool execution progress and third-party extension
 *    statuses published via ctx.ui.setStatus(). Omitted entirely when empty.
 *
 *  Editor:
 *    The default Pi editor is wrapped in a neutral grey frame with a metadata
 *    line (model + thinking level) inside, and the border is held grey so it
 *    never tracks the thinking level.
 *
 * Toggle: /statusbar
 */

import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
  removeEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { formatStatusLine } from "../../lib/ui-format.ts";
import { FLEX_EVENT, ICON_COLOR, STATUS_ICON, STATUS_KEY, TEXT_COLOR } from "./src/constants.ts";
import { getModelLabel, PolishedEditor } from "./src/editor.ts";
import { buildFooterLines } from "./src/footer.ts";
import { parseGitStatus } from "./src/git.ts";
import type { State } from "./src/types.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./src/constants.ts";
export {
  buildEditorMetaSegments,
  type PolishedFrameInput,
  renderPolishedFrame,
} from "./src/editor.ts";

// --- Extension ---

export default async function statusBarExtension(pi: ExtensionAPI) {
  const state: State = {
    enabled: true,
    turnCount: 0,
    thinkingLevel: "none",
    activeTools: [],
    completedToolCount: 0,
    gitBranch: null,
    gitStatus: null,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    lastHandle: null,
    flexOn: false,
    flexCapable: false,
  };

  let getBranch: () => any[] = () => [];
  let currentCwd = "";

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
          () => pi.getThinkingLevel() ?? "none",
          () => ({ on: state.flexOn, capable: state.flexCapable }),
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

  function resetTurnState(): void {
    state.activeTools = [];
    state.completedToolCount = 0;
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
    resetTurnState();
    accumulateTokenUsage();

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

    // Subscribe to Neuralwatt flex state changes to render the flex badge next
    // to the thinking level. Keeps the metadata line in sync with the toggle
    // without coupling the status-bar editor to Neuralwatt's internals.
    pi.events.on(FLEX_EVENT, (flex: { flexOn: boolean; flexCapable: boolean }) => {
      state.flexOn = flex.flexOn;
      state.flexCapable = flex.flexCapable;
      state.lastHandle?.requestRender();
      editorRequestRender?.();
    });

    await refreshGitStatus();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearFooter(ctx as ExtensionCommandContext);
    restoreEditor(ctx as ExtensionCommandContext);
  });

  pi.on("turn_start", async (_event, _ctx) => {
    state.turnCount++;
    resetTurnState();
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("turn_end", async (_event, _ctx) => {
    accumulateTokenUsage();
    await refreshGitStatus();
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("message_end", async (_event, _ctx) => {
    accumulateTokenUsage();
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("model_select", async (_event, _ctx) => {
    if (state.lastHandle) state.lastHandle.requestRender();
    editorRequestRender?.();
  });

  pi.on("thinking_level_select", async (event, _ctx) => {
    state.thinkingLevel = event.level;
    if (state.lastHandle) state.lastHandle.requestRender();
    editorRequestRender?.();
  });

  pi.on("tool_execution_start", async (event, _ctx) => {
    state.activeTools.push({ name: event.toolName, id: event.toolCallId });
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    state.activeTools = state.activeTools.filter((t) => t.id !== event.toolCallId);
    state.completedToolCount++;
    if (state.lastHandle) state.lastHandle.requestRender();
  });

  // --- Command ---

  pi.registerCommand("statusbar", {
    description: "Toggle the Starship-inspired status bar footer",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      state.enabled = !state.enabled;

      if (state.enabled) {
        state.thinkingLevel = pi.getThinkingLevel() ?? "none";
        currentCwd = ctx.cwd;
        getBranch = () => ctx.sessionManager.getBranch();
        accumulateTokenUsage();
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
