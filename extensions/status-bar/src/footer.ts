import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import {
  APPROVAL_STATUS_KEY,
  AUTORESEARCH_STATUS_KEY,
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
} from "./constants.ts";
import type { GitStatus, State, TokenUsage } from "./types.ts";

// --- Utilities ---

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
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

/**
 * Right-block pieces, fullest variant first. When width is tight the right
 * block is shed in tiers — cost first, then the turn count, then mail, then
 * the token breakdown, with the decorative bar dropping early and the window
 * surviving longest — before the static left block is ever truncated, so the
 * context window stays visible as long as possible.
 */
function rightBlockVariants(
  bar: string,
  windowStr: string,
  tokenStr: string,
  turnStr: string,
  mailStr: string,
  costStr: string,
  workerStr: string,
): string[] {
  const join = (parts: string[]) => parts.filter(Boolean).join(" ");
  // Shedding order: cost, worker spend, turn count, mail, token breakdown —
  // bar and window survive longest. The worker segment rides along wherever
  // the cost segment appears.
  return [
    join([bar, windowStr, tokenStr, turnStr, mailStr, costStr, workerStr]),
    join([bar, windowStr, tokenStr, turnStr, mailStr]),
    join([windowStr, tokenStr, turnStr, mailStr, costStr, workerStr]),
    join([windowStr, tokenStr, turnStr, mailStr]),
    join([tokenStr, turnStr, mailStr, costStr, workerStr]),
    join([tokenStr, turnStr, mailStr]),
    join([tokenStr, mailStr]),
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

export function buildFooterLines(
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
  // Reads the cached snapshot (refreshed on message boundaries) so a render —
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
  // Turn count sits right of the token counters, leading the trailing trio
  // with mail and cost. Cost always shown — $0.000 at session start, 3
  // decimals. Mail appears only while mail is unread, and sheds after the
  // turn count but before the token breakdown (see rightBlockVariants).
  const turnStr = theme.fg("text", `${ICON_TURN}${state.turnCount}`);
  const mailStr =
    state.unreadMail > 0 ? theme.fg(MAIL_COLOR, `${ICON_MAIL} ${state.unreadMail}`) : "";
  const costStr = theme.fg("mdHeading", `$${tu.cost.toFixed(3)}`);
  // Delegated-worker spend roll-up (published on workers:state). Sheds with
  // the cost segment — ambient totals, not actionable mid-turn.
  const workerStr =
    state.workerCostUsd > 0
      ? theme.fg(
          WORKER_COLOR,
          `${ICON_WORKER} $${state.workerCostUsd < 0.01 ? "<0.01" : state.workerCostUsd.toFixed(2)}${state.workerTokens > 0 ? ` · ${formatTokenCount(state.workerTokens)}` : ""}`,
        )
      : "";

  const line1 = composeLine1(
    leftSegments.join(" "),
    rightBlockVariants(
      barStr,
      windowStr ? theme.fg("text", windowStr) : "",
      tokenStr,
      turnStr,
      mailStr,
      costStr,
      workerStr,
    ),
    width,
  );

  // --- Line 2: transient events (third-party extension statuses) ---
  const line2Segments: string[] = [];

  const extStatuses = footerData?.getExtensionStatuses?.();
  if (extStatuses) {
    for (const [key, text] of extStatuses) {
      // Skip our own indicator and the small-model status: the small model is
      // shown in the editor meta line, not the footer. Skip goal: a running
      // goal is shown as a "Goal" badge in the editor frame. Skip missions,
      // messenger and autoresearch as well: their setStatus entries are
      // fallback text for the default footer. Approval Mode shows its off
      // state in the editor instead. Messenger's unread count reaches line 1
      // via messenger:state.
      if (
        key !== STATUS_KEY &&
        key !== SMALL_MODEL_STATUS_KEY &&
        key !== GOAL_STATUS_KEY &&
        key !== MISSIONS_STATUS_KEY &&
        key !== MESSENGER_STATUS_KEY &&
        key !== AUTORESEARCH_STATUS_KEY &&
        key !== APPROVAL_STATUS_KEY &&
        text
      ) {
        line2Segments.push(text);
      }
    }
  }

  const lines = [line1];
  if (line2Segments.length > 0) {
    lines.push(truncateToWidth(line2Segments.join("  "), width, ""));
  }
  return lines;
}
