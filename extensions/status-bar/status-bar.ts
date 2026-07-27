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
import { EDITOR_MARKER, ICON_COLOR, STATUS_ICON, STATUS_KEY, TEXT_COLOR } from "./src/constants.ts";
import { getModelLabel, PolishedEditor } from "./src/editor.ts";
import { buildFooterLines } from "./src/footer.ts";
import { parseGitStatus } from "./src/git.ts";
import type { State } from "./src/types.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./src/constants.ts";
export { type PolishedFrameInput, renderPolishedFrame } from "./src/editor.ts";

// --- Extension factory ---

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

  // --- Editor: wrap Pi's input editor in a neutral grey frame with the model
  // and thinking level shown inside. State is per-invocation (fresh per Pi
  // instance / test) — declared here, not at module scope, to avoid leaking.
  let baseEditorFactory: any;
  let installedEditorFactory: any;
  let editorRequestRender: (() => void) | undefined;

  function makePolishedFactory(
    ctx: ExtensionCommandContext,
  ): (tui: any, theme: any, kb: any) => any {
    const factory = (tui: any, theme: any, kb: any) => {
      editorRequestRender = () => tui.requestRender();
      return new PolishedEditor(
        tui,
        theme,
        kb,
        ctx.ui.theme,
        () => getModelLabel(ctx),
        () => pi.getThinkingLevel() ?? "none",
      );
    };
    (factory as any)[EDITOR_MARKER] = true;
    return factory as any;
  }

  function installEditor(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    const current = ctx.ui.getEditorComponent();
    if (current && (current as any)[EDITOR_MARKER]) {
      installedEditorFactory = current;
      return; // already ours
    }
    baseEditorFactory = current; // capture Pi's default (undefined) or another extension's
    installedEditorFactory = makePolishedFactory(ctx);
    ctx.ui.setEditorComponent(installedEditorFactory);
  }

  function restoreEditor(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    const current = ctx.ui.getEditorComponent();
    if (current && (current as any)[EDITOR_MARKER]) {
      // undefined restores Pi's default editor; a captured factory restores another extension's.
      ctx.ui.setEditorComponent(baseEditorFactory ?? undefined);
    }
    installedEditorFactory = undefined;
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
        `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "statusbar")}`,
      );
      // Re-check after a tick: another extension that loads later may replace
      // our editor. If so, re-install so the frame stays in place.
      setTimeout(() => {
        if (!state.enabled) return;
        const current = (ctx as ExtensionCommandContext).ui.getEditorComponent();
        if (current !== installedEditorFactory) installEditor(ctx as ExtensionCommandContext);
      }, 0);
    }

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
          `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, "statusbar")}`,
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
