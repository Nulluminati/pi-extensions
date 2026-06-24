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

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";

// --- Constants ---

// Self-indicator icon: a Nerd Font bottom-dock glyph in the "enabled" hue with
// a greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf10a9); // nf-md-dock-bottom
export const ICON_COLOR = "success";
export const TEXT_COLOR = "muted";

const STATUS_KEY = "status-bar";
const BAR_SEGMENTS = 10;
const MAX_TOOL_NAME = 18;

// Nerd Font icons (Starship-inspired). The two Material Design glyphs live
// in the Private Use Area, so they're built from codepoints to survive any
// transport that would strip an invisible literal to a space.
const ICON_CWD = String.fromCodePoint(0xf0770); // nf-md-folder
const ICON_GIT = String.fromCodePoint(0xf418); // nf-md-git
const ICON_THINKING = String.fromCodePoint(0xf09d1); // nf-md-brain
const ICON_TURN = "↻";
const ICON_TOOL_ACTIVE = "⚙";
const ICON_TOOL_DONE = "✓";

// Git status indicators (Starship).
const ICON_AHEAD = "↑";
const ICON_BEHIND = "↓";
const ICON_DIVERGED = "⇕";
const ICON_CONFLICTED = "=";
const ICON_UNTRACKED = "?";
const ICON_STASHED = "$";
const ICON_MODIFIED = "!";
const ICON_STAGED = "+";
const ICON_RENAMED = "»";
const ICON_DELETED = "✘";
const ICON_TYPECHANGED = "T";

const THINKING_THEME_COLOR: Record<string, string> = {
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
};

// Distinct hues per token indicator, drawn from the theme's harmonized
// palette (the same family as the model/directory colors) so they match the
// terminal rather than clashing VS Code syntax hexes or raw semantic colors.
const TOKEN_COLORS = {
  input: "accent", // ↑ teal — matches the model
  output: "mdHeading", // ↓ gold
  cacheRead: "mdLink", // ↗ blue — matches the directory
  cacheWrite: "thinkingHigh", // ↘ purple
} as const;

// Neutral grey used for the polished editor frame. Held constant so the input
// box never tracks the thinking-level border color.
const EDITOR_FRAME_COLOR = "borderMuted";
const EDITOR_META_SEPARATOR = "  ";
const EDITOR_MARKER = Symbol.for("pi-statusbar.editor-factory");

// --- Types ---

interface ToolExecution {
  name: string;
  id: string;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface GitStatus {
  ahead: number;
  behind: number;
  conflicted: number;
  untracked: number;
  stashed: boolean;
  modified: number;
  staged: number;
  renamed: number;
  deleted: number;
  typechanged: number;
}

interface State {
  enabled: boolean;
  turnCount: number;
  thinkingLevel: string;
  activeTools: ToolExecution[];
  completedToolCount: number;
  gitBranch: string | null;
  gitStatus: GitStatus | null;
  tokenUsage: TokenUsage;
  lastHandle: { requestRender: () => void; close: () => void } | null;
}

// --- Utilities ---

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function buildUsageBar(percent: number, theme: any): string {
  const filled = Math.round((percent / 100) * BAR_SEGMENTS);
  const empty = BAR_SEGMENTS - filled;

  let color: string;
  if (percent >= 90) color = "error";
  else if (percent >= 70) color = "warning";
  else color = "success";

  const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
  return theme.fg("dim", "[") + bar + theme.fg("dim", "]");
}

/**
 * Token breakdown: always shows all four indicators (↑ ↓ ↗ ↘), rendering 0
 * when a bucket is empty rather than hiding the segment.
 */
function formatTokenBreakdown(tu: TokenUsage, theme: any): string {
  const parts = [
    theme.fg(TOKEN_COLORS.input, `↑${formatTokenCount(tu.input)}`),
    theme.fg(TOKEN_COLORS.output, `↓${formatTokenCount(tu.output)}`),
    theme.fg(TOKEN_COLORS.cacheRead, `↗${formatTokenCount(tu.cacheRead)}`),
    theme.fg(TOKEN_COLORS.cacheWrite, `↘${formatTokenCount(tu.cacheWrite)}`),
  ];
  return parts.join(" ");
}

function formatToolProgress(state: State, theme: any): string {
  if (state.activeTools.length === 0 && state.completedToolCount === 0) return "";

  const parts: string[] = [];
  if (state.activeTools.length > 0) {
    const names = state.activeTools.map((t) =>
      t.name.length > MAX_TOOL_NAME ? `${t.name.slice(0, MAX_TOOL_NAME - 1)}…` : t.name,
    );
    parts.push(`${theme.fg("accent", ICON_TOOL_ACTIVE)} ${theme.fg("accent", names.join(", "))}`);
  }
  if (state.completedToolCount > 0) {
    parts.push(theme.fg("dim", `${ICON_TOOL_DONE}${state.completedToolCount}`));
  }
  return parts.join(" ");
}

function formatCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function buildGitStatusBlock(gs: GitStatus, theme: any): string {
  const indicators: string[] = [];
  if (gs.conflicted > 0) indicators.push(ICON_CONFLICTED);
  if (gs.stashed) indicators.push(ICON_STASHED);
  if (gs.deleted > 0) indicators.push(ICON_DELETED);
  if (gs.renamed > 0) indicators.push(ICON_RENAMED);
  if (gs.modified > 0) indicators.push(ICON_MODIFIED);
  if (gs.typechanged > 0) indicators.push(ICON_TYPECHANGED);
  if (gs.staged > 0) indicators.push(ICON_STAGED);
  if (gs.untracked > 0) indicators.push(ICON_UNTRACKED);

  let aheadBehind = "";
  if (gs.ahead > 0 && gs.behind > 0) aheadBehind = ICON_DIVERGED;
  else if (gs.ahead > 0) aheadBehind = ICON_AHEAD;
  else if (gs.behind > 0) aheadBehind = ICON_BEHIND;

  if (indicators.length === 0 && !aheadBehind) return "";
  return ` ${theme.fg("error", `[${indicators.join("")}${aheadBehind}]`)}`;
}

function parseGitStatus(stdout: string, hasStash: boolean): GitStatus {
  const status: GitStatus = {
    ahead: 0,
    behind: 0,
    conflicted: 0,
    untracked: 0,
    stashed: hasStash,
    modified: 0,
    staged: 0,
    renamed: 0,
    deleted: 0,
    typechanged: 0,
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        status.ahead = Number(match[1] ?? 0);
        status.behind = Number(match[2] ?? 0);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    if (line.startsWith("? ")) {
      status.untracked++;
      continue;
    }
    if (line.startsWith("u ")) {
      status.conflicted++;
      continue;
    }
    if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;

    const xy = line.split(" ")[1] ?? "..";
    const x = xy[0] ?? ".";
    const y = xy[1] ?? ".";

    if (x === "R") status.renamed++;
    else if (x === "D") status.deleted++;
    else if (x === "T") status.typechanged++;
    else if (x !== "." && x !== " ") status.staged++;

    if (y === "M") status.modified++;
    else if (y === "D") status.deleted++;
    else if (y === "T") status.typechanged++;
  }

  return status;
}

function getModelLabel(ctx: ExtensionCommandContext): string {
  const modelId = ctx.model?.id ?? "no-model";
  const provider = ctx.model?.provider;
  return provider ? `${provider}/${modelId}` : modelId;
}

/**
 * Build the metadata segments shown inside the editor frame: the model label
 * (accent) and the thinking level (color-coded per level, muted when off),
 * both always visible. Segments are pre-colored so the frame function stays a
 * pure layout concern.
 */
function buildEditorMetaSegments(modelLabel: string, thinkingLevel: string, theme: any): string[] {
  const segments: string[] = [];
  if (modelLabel) segments.push(theme.fg("accent", modelLabel));
  const level = thinkingLevel || "none";
  const color = THINKING_THEME_COLOR[level] ?? "muted";
  segments.push(theme.fg(color, `${ICON_THINKING} ${level}`));
  return segments;
}

export interface PolishedFrameInput {
  /** Raw lines produced by the base editor's render(). */
  baseRendered: string[];
  /** Number of trailing lines that belong to the autocomplete dropdown. */
  autocompleteCount: number;
  width: number;
  /** Pre-colored metadata segments (model, thinking) for the meta line. */
  metaSegments: string[];
  theme: any;
}

/**
 * Wrap the base editor's rendered output in a neutral grey frame with a
 * metadata line (model + thinking level) inside, adding padding lines so the
 * box is taller. The base editor's own top/bottom borders are stripped (the
 * frame supplies its own); autocomplete lines are preserved below the bottom
 * border. Pure — tested directly with synthetic base output.
 */
export function renderPolishedFrame(input: PolishedFrameInput): string[] {
  const { baseRendered, autocompleteCount, width, metaSegments, theme } = input;
  const fallback = () => baseRendered.map((line) => truncateToWidth(line, Math.max(0, width), ""));
  if (width <= 2 || baseRendered.length < 2) return fallback();

  const acCount =
    autocompleteCount > 0 && autocompleteCount < baseRendered.length ? autocompleteCount : 0;
  const frame = acCount > 0 ? baseRendered.slice(0, -acCount) : baseRendered;
  if (frame.length < 2) return fallback();

  // Strip the base editor's own top and bottom border rows.
  const contentLines = frame.slice(1, -1);
  const autocompleteLines = acCount > 0 ? baseRendered.slice(-acCount) : [];

  const grey = (text: string) => theme.fg(EDITOR_FRAME_COLOR, text);
  const innerWidth = Math.max(0, width);
  const fill = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, "");
    return `${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}`;
  };
  const border = grey("─".repeat(width));
  const meta = metaSegments.filter(Boolean).join(grey(EDITOR_META_SEPARATOR));

  const lines: string[] = [border];
  for (const content of contentLines) lines.push(fill(content));
  lines.push(fill(""));
  if (meta) lines.push(fill(meta));
  lines.push(border);
  for (const ac of autocompleteLines) lines.push(truncateToWidth(ac, width, ""));
  return lines;
}

/**
 * The default Pi editor, framed in a neutral grey box with the model and
 * thinking level shown on a metadata line inside. Subclasses CustomEditor so
 * all text handling, keybindings, autocomplete, and history are inherited;
 * only render() is overridden to add the frame.
 */
class PolishedEditor extends CustomEditor {
  private readonly uiTheme: any;
  private readonly getModelLabel: () => string;
  private readonly getThinkingLevel: () => string;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    uiTheme: any,
    getModelLabel: () => string,
    getThinkingLevel: () => string,
  ) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.uiTheme = uiTheme;
    this.getModelLabel = getModelLabel;
    this.getThinkingLevel = getThinkingLevel;
    // Hold the border grey so the input box never tracks the thinking level.
    this.borderColor = (str: string) => uiTheme.fg(EDITOR_FRAME_COLOR, str);
  }

  render(width: number): string[] {
    if (width <= 2) return super.render(width);
    // No left rail: the base editor renders at the full width and the frame
    // pads its content lines out to match.
    const innerWidth = Math.max(1, width);
    const baseRendered = super.render(innerWidth);
    const autocompleteCount = this.computeAutocompleteCount(innerWidth);
    return renderPolishedFrame({
      baseRendered,
      autocompleteCount,
      width,
      metaSegments: buildEditorMetaSegments(
        this.getModelLabel(),
        this.getThinkingLevel(),
        this.uiTheme,
      ),
      theme: this.uiTheme,
    });
  }

  /**
   * Count trailing autocomplete lines the base editor appended below its bottom
   * border, so they can be preserved below the frame's bottom border instead
   * of being treated as content.
   */
  private computeAutocompleteCount(innerWidth: number): number {
    const base = this as unknown as {
      isShowingAutocomplete?: () => boolean;
      autocompleteList?: { render: (width: number) => string[] };
    };
    if (typeof base.isShowingAutocomplete !== "function") return 0;
    if (!base.isShowingAutocomplete()) return 0;
    const list = base.autocompleteList;
    if (!list || typeof list.render !== "function") return 0;
    try {
      return list.render(innerWidth).length;
    } catch {
      return 0;
    }
  }
}

/**
 * Right-block pieces, fullest variant first. When width is tight the right
 * block is shed in tiers (dropping cost, then the decorative bar) before the
 * static left block is ever truncated, so token counts and the context window
 * stay visible as long as possible.
 */
function rightBlockVariants(
  bar: string,
  windowStr: string,
  tokenStr: string,
  turnStr: string,
  costStr: string,
): string[] {
  const join = (parts: string[]) => parts.filter(Boolean).join(" ");
  return [
    join([bar, windowStr, tokenStr, turnStr, costStr]),
    join([bar, windowStr, tokenStr, turnStr]),
    join([windowStr, tokenStr, turnStr, costStr]),
    join([windowStr, tokenStr, turnStr]),
    join([tokenStr, turnStr, costStr]),
    join([tokenStr, turnStr]),
    join([tokenStr]),
    join([windowStr]),
    join([]),
  ];
}

/**
 * Compose line 1: a left block with a right block right-aligned beside it.
 * Tries each right-block variant from fullest to emptiest, keeping the first
 * that fits alongside the full left block. If none fits, the left block is
 * truncated so the result never exceeds `width`.
 */
function composeLine1(left: string, rightVariants: string[], width: number): string {
  const leftWidth = visibleWidth(left);

  for (const right of rightVariants) {
    const rightWidth = right ? visibleWidth(right) : 0;
    const needed = leftWidth + (rightWidth > 0 ? 1 + rightWidth : 0);
    if (needed <= width) {
      if (rightWidth === 0) return truncateToWidth(left, width, "");
      const gap = width - leftWidth - rightWidth;
      return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
    }
  }

  // Even the empty right block doesn't fit: truncate the left block.
  return truncateToWidth(left, width, "");
}

function buildFooterLines(
  state: State,
  ctx: ExtensionCommandContext,
  theme: any,
  footerData: any,
  width: number,
): string[] {
  // --- Line 1: static session segments. Model + thinking level live in the
  // editor box, not the footer, so line 1 opens with the working directory. ---
  const leftSegments: string[] = [];

  // Working directory (last path component) — blue, Starship-style.
  leftSegments.push(theme.fg("mdLink", `${ICON_CWD} ${formatCwd(ctx.cwd)}`));

  // Git branch + status indicator block. Branch in purple (Starship's
  // signature), status indicators in red.
  const branch = state.gitBranch ?? footerData?.getGitBranch?.() ?? null;
  if (branch) {
    const block = state.gitStatus ? buildGitStatusBlock(state.gitStatus, theme) : "";
    leftSegments.push(
      `${theme.fg("dim", "on")} ${theme.fg("thinkingHigh", `${ICON_GIT} ${branch}`)}${block}`,
    );
  }

  // Right block: context usage bar + window, token breakdown, cost. Shed in
  // tiers when narrow (see rightBlockVariants) so the static left block wins.
  let barStr = "";
  let windowStr = "";

  const usage = ctx.getContextUsage();
  if (usage && usage.tokens !== null && usage.contextWindow > 0) {
    const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
    barStr = buildUsageBar(pct, theme);
    windowStr = `${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)}`;
  }

  // Token breakdown: always shown (0 when empty), each indicator colored.
  const tu = state.tokenUsage;
  const tokenStr = formatTokenBreakdown(tu, theme);
  // Turn count sits right of the token counters, leading the trailing pair
  // with cost. Cost always shown — $0.000 at session start, 3 decimals.
  const turnStr = theme.fg("text", `${ICON_TURN}${state.turnCount}`);
  const costStr = theme.fg("mdHeading", `$${tu.cost.toFixed(3)}`);

  const line1 = composeLine1(
    leftSegments.join(" "),
    rightBlockVariants(
      barStr,
      windowStr ? theme.fg("text", windowStr) : "",
      tokenStr,
      turnStr,
      costStr,
    ),
    width,
  );

  // --- Line 2: transient events (tools + third-party extension statuses) ---
  const line2Segments: string[] = [];

  const toolProg = formatToolProgress(state, theme);
  if (toolProg) line2Segments.push(toolProg);

  const extStatuses = footerData?.getExtensionStatuses?.();
  if (extStatuses) {
    for (const [key, text] of extStatuses) {
      if (key !== STATUS_KEY && text) line2Segments.push(text);
    }
  }

  const lines = [line1];
  if (line2Segments.length > 0) {
    lines.push(truncateToWidth(line2Segments.join("  "), width, ""));
  }
  return lines;
}

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
