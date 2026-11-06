import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import {
  APPROVAL_STATUS_KEY,
  AUTORESEARCH_STATUS_KEY,
  BACKGROUND_JOBS_STATUS_KEY,
  BAR_SEGMENTS,
  GOAL_STATUS_KEY,
  ICON_AHEAD,
  ICON_BEHIND,
  ICON_CONFLICTED,
  ICON_CWD,
  ICON_DELETED,
  ICON_DIVERGED,
  ICON_GIT,
  ICON_MAIL,
  ICON_MODIFIED,
  ICON_RENAMED,
  ICON_STAGED,
  ICON_STASHED,
  ICON_TURN,
  ICON_TYPECHANGED,
  ICON_UNTRACKED,
  ICON_WORKER,
  MAIL_COLOR,
  MESSENGER_STATUS_KEY,
  MISSIONS_STATUS_KEY,
  SMALL_MODEL_STATUS_KEY,
  STATUS_KEY,
  TOKEN_COLORS,
  WORKER_COLOR,
  WORKERS_STATUS_KEY,
} from "./constants.ts";
import type { GitStatus, State, TokenUsage } from "./types.ts";

// --- Utilities ---

// Keep the framed editor and some conversation space outside the footer.
const MIN_EDITOR_ROWS = 6;

function formatTokenCount(n: number): string {
  // Use the rounded k value so 999,950-999,999 shows as 1.0m, not 1000.0k.
  const thousands = (n / 1000).toFixed(1);
  if (n >= 1_000_000 || thousands === "1000.0") return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${thousands}k`;
  return `${n}`;
}

function buildUsageBar(percent: number, theme: any): string {
  // Clamp so a context larger than the window (e.g. a continued session whose
  // prior context exceeds the selected model's window) renders a full bar
  // instead of passing a negative count to String.repeat and crashing.
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_SEGMENTS);
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

interface FooterPanel {
  title: string;
  rows: string[];
}

/** Fit panels beside each other when possible; otherwise stack and wrap them. */
function renderPanels(panels: FooterPanel[], theme: any, width: number): string[] {
  if (width === 0) return [];
  // At tiny widths the frame title cannot fit. Keep the content width-safe.
  if (width < 12) {
    return panels
      .flatMap((panel) => panel.rows.flatMap((row) => wrapTextWithAnsi(row, width)))
      .map((line) => truncateToWidth(line, width, ""));
  }

  const naturalWidths = panels.map((panel) =>
    Math.max(24, visibleWidth(panel.title) + 8, ...panel.rows.map((row) => visibleWidth(row) + 4)),
  );
  const naturalRowWidth = naturalWidths.reduce((sum, size) => sum + size, 0) + panels.length - 1;
  const horizontal = naturalRowWidth <= width;
  const extraWidth = Math.max(0, width - naturalRowWidth);
  const panelWidths = naturalWidths.map((size, index) =>
    horizontal
      ? size + Math.floor(extraWidth / panels.length) + (index < extraWidth % panels.length ? 1 : 0)
      : width,
  );
  const bodies = panels.map((panel, index) => {
    const panelWidth = panelWidths[index] ?? width;
    const contentWidth = modalContentWidth(panelWidth, 1);
    return panel.rows.flatMap((row) => wrapTextWithAnsi(row, contentWidth));
  });
  const bodyHeight = Math.max(...bodies.map((body) => body.length));
  const frames = panels.map((panel, index) => {
    const body = [...(bodies[index] ?? [])];
    if (horizontal) while (body.length < bodyHeight) body.push("");
    return renderModalFrame(theme, panelWidths[index] ?? width, body, {
      title: panel.title,
      paddingX: 1,
      paddingY: 0,
      borderColor: "dim",
    });
  });
  if (!horizontal) return frames.flat();
  return (frames[0] ?? []).map((_, row) => frames.map((frame) => frame[row] ?? "").join(" "));
}

export function buildFooterLines(
  state: State,
  ctx: ExtensionCommandContext,
  theme: any,
  footerData: any,
  width: number,
  terminalRows = 24,
): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const height = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 24;
  const maxRows = Math.max(0, Math.min(Math.floor(height / 2), height - MIN_EDITOR_ROWS));
  if (width === 0 || maxRows === 0) return [];
  // Model + thinking level live in the editor box, not the footer.
  const workspaceRows: string[] = [];

  // Working directory (last path component) — blue, Starship-style.
  workspaceRows.push(theme.fg("mdLink", `${ICON_CWD} ${formatCwd(ctx.cwd)}`));

  // Git branch + status indicator block. Branch in purple (Starship's
  // signature), status indicators in red.
  const branch = state.gitBranch ?? footerData?.getGitBranch?.() ?? null;
  if (branch) {
    const block = state.gitStatus ? buildGitStatusBlock(state.gitStatus, theme) : "";
    workspaceRows.push(`${theme.fg("thinkingHigh", `${ICON_GIT} ${branch}`)}${block}`);
  }

  // Context usage reads the cached snapshot (refreshed on message boundaries) so a render —
  // which fires on every keystroke — never recomputes O(conversation) usage.
  let barStr = "";
  let windowStr = "";

  const usage = state.contextUsage;
  if (usage && usage.tokens !== null && usage.contextWindow > 0) {
    const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
    barStr = buildUsageBar(pct, theme);
    windowStr = `${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)}`;
  }

  // Token breakdown: always shown (0 when empty), each indicator colored.
  const tu = state.tokenUsage;
  const tokenStr = formatTokenBreakdown(tu, theme);
  // Session activity stays separate from context usage. Cost always shows
  // three decimals; mail appears only while unread.
  const turnStr = theme.fg("text", `${ICON_TURN}${state.turnCount}`);
  const mailStr =
    state.unreadMail > 0 ? theme.fg(MAIL_COLOR, `${ICON_MAIL} ${state.unreadMail}`) : "";
  const costStr = theme.fg("mdHeading", `$${tu.cost.toFixed(3)}`);
  // Delegated-worker spend roll-up (published on workers:state). Workers on
  // unpriced models report zero cost, so tokens alone still show the segment.
  const workerParts = [
    ...(state.workerCostUsd > 0
      ? [`$${state.workerCostUsd < 0.01 ? "<0.01" : state.workerCostUsd.toFixed(2)}`]
      : []),
    ...(state.workerTokens > 0 ? [formatTokenCount(state.workerTokens)] : []),
  ];
  const workerStr =
    workerParts.length > 0
      ? theme.fg(WORKER_COLOR, `${ICON_WORKER} ${workerParts.join(" · ")}`)
      : "";

  const contextRows = [
    ...(windowStr ? [`${barStr} ${theme.fg("text", windowStr)}`] : []),
    tokenStr,
  ];
  const panels: FooterPanel[] = [
    { title: "Workspace", rows: workspaceRows },
    { title: "Context", rows: contextRows },
    { title: "Session", rows: [`${turnStr}  ${costStr}`, mailStr, workerStr].filter(Boolean) },
  ];

  // --- Transient events (third-party extension statuses) ---
  const transientStatuses: string[] = [];

  const extStatuses = footerData?.getExtensionStatuses?.();
  if (extStatuses) {
    for (const [key, text] of extStatuses) {
      // Skip our own indicator and the small-model status: the small model is
      // shown in the editor meta line, not the footer. Skip goal: a running
      // goal is shown as a "Goal" badge in the editor frame. Skip missions,
      // messenger, autoresearch, workers and background-jobs as well: their
      // setStatus entries are fallback text for the default footer. Approval
      // Mode shows its off state in the editor instead. Messenger's unread
      // count reaches the Session panel via messenger:state.
      if (
        key !== STATUS_KEY &&
        key !== SMALL_MODEL_STATUS_KEY &&
        key !== GOAL_STATUS_KEY &&
        key !== MISSIONS_STATUS_KEY &&
        key !== MESSENGER_STATUS_KEY &&
        key !== AUTORESEARCH_STATUS_KEY &&
        key !== WORKERS_STATUS_KEY &&
        key !== BACKGROUND_JOBS_STATUS_KEY &&
        key !== APPROVAL_STATUS_KEY &&
        text
      ) {
        transientStatuses.push(text);
      }
    }
  }

  let lines = renderPanels(panels, theme, width);
  const panelBudget = maxRows - (transientStatuses.length > 0 ? 1 : 0);
  if (lines.length > panelBudget) {
    // Drop frame strokes before content. One row per value keeps long paths
    // from consuming the space needed by Context and Session.
    lines = panels.flatMap((panel) =>
      panel.rows.map((row, index) =>
        truncateToWidth(
          (index === 0 ? theme.fg("accent", `${panel.title}: `) : "") + row,
          width,
          "…",
        ),
      ),
    );
  }
  for (const text of transientStatuses) {
    lines.push(...wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width, "")));
  }
  if (lines.length > maxRows) {
    const hidden = lines.length - maxRows + 1;
    return [
      ...lines.slice(0, maxRows - 1),
      truncateToWidth(theme.fg("dim", `↓ ${hidden} more lines`), width, ""),
    ];
  }
  return lines;
}
