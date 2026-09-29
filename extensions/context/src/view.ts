/**
 * Rendering for the context view: a framed TUI modal (Claude Code /context
 * style) and a plain-text variant used when there is no UI (print/json mode).
 */

import type { ExtensionCommandContext } from "pi";
import { PANEL_OVERLAY_OPTIONS } from "../../../lib/overlay-options.ts";
import { formatTokenCount as formatSharedTokenCount } from "../../../lib/token-count.ts";
import {
  type ModalFrameOptions,
  modalContentWidth,
  renderModalFrame,
} from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import type { ContextBreakdown } from "./measure.ts";

// --- Utilities ---

function formatTokenCount(n: number): string {
  return formatSharedTokenCount(n, { underThousand: "raw", thousands: "fixed", millions: "fixed" });
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/**
 * Segmented bar over the whole window: used (provider-reported) split between
 * system prompt and conversation by their estimates, then free space.
 */
function buildUsageBar(theme: any, data: ContextBreakdown, width: number): string {
  const { contextWindow, usedTokens } = data;
  if (contextWindow <= 0 || width < 8) return "";

  const used = usedTokens ?? Math.min(contextWindow, data.systemPromptTokens + data.messageTokens);
  const clampedUsed = Math.max(0, Math.min(contextWindow, used));
  const segments = width;
  const usedSegments = Math.round((clampedUsed / contextWindow) * segments);
  const sysSegments = Math.min(
    usedSegments,
    Math.round((data.systemPromptTokens / contextWindow) * segments),
  );
  const convoSegments = usedSegments - sysSegments;
  const freeSegments = segments - usedSegments;

  const block = "█";
  return (
    theme.fg("accent", block.repeat(sysSegments)) +
    theme.fg("success", block.repeat(convoSegments)) +
    theme.fg("dim", block.repeat(freeSegments))
  );
}

function buildModalLines(theme: any, data: ContextBreakdown, width: number): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const text = (s: string) => theme.fg("text", s);
  const rule = dim("─".repeat(Math.max(1, modalContentWidth(width, 2))));
  const tablePad = 20;
  const row = (label: string, tokens: string, detail?: string): string => {
    const pad = " ".repeat(Math.max(1, tablePad - label.length));
    const detailStr = detail ? dim(`  ${detail}`) : "";
    return dim(label) + pad + text(tokens) + detailStr;
  };
  const plural = (n: number) => (n === 1 ? "" : "s");

  const lines: string[] = [];

  // Model + headline usage
  lines.push(muted("Model: ") + text(data.modelLabel));
  if (data.usedTokens === null || data.contextWindow <= 0) {
    lines.push(muted("Used: ") + dim("(unknown — no assistant usage yet)"));
  } else {
    const pct = data.percent ?? (data.usedTokens / data.contextWindow) * 100;
    const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "text";
    const freeStr = data.freeTokens !== null ? ` · ${formatTokenCount(data.freeTokens)} free` : "";
    lines.push(
      muted("Used: ") +
        text(`${formatTokenCount(data.usedTokens)} / ${formatTokenCount(data.contextWindow)}`) +
        dim(` (${theme.fg(color, formatPercent(pct))}${freeStr})`),
    );
    const bar = buildUsageBar(theme, data, 34);
    if (bar) {
      lines.push(
        bar +
          dim("  sys") +
          theme.fg("accent", "█") +
          dim(" convo") +
          theme.fg("success", "█") +
          dim(" free") +
          theme.fg("dim", "█"),
      );
    }
  }

  // Category table
  lines.push(rule);
  lines.push(row("System prompt", formatTokenCount(data.systemPromptTokens), "est"));
  const fileTokens = data.contextFiles.reduce((sum, file) => sum + file.tokens, 0);
  if (data.contextFiles.length > 0) {
    lines.push(
      row(
        "  Context files",
        formatTokenCount(fileTokens),
        `${data.contextFiles.length} file${plural(data.contextFiles.length)}`,
      ),
    );
    for (const file of data.contextFiles) {
      lines.push(row(`    ${file.path}`, formatTokenCount(file.tokens)));
    }
  }
  const skillTokens = data.skills.reduce((sum, skill) => sum + skill.tokens, 0);
  if (data.skills.length > 0) {
    lines.push(
      row(
        "  Skills",
        formatTokenCount(skillTokens),
        `${data.skills.length} skill${plural(data.skills.length)}`,
      ),
    );
  }
  lines.push(row("  Tools", formatTokenCount(data.toolsTokens), `${data.activeToolCount} active`));
  lines.push(row("Messages", formatTokenCount(data.messageTokens), `${data.messageCount} entries`));
  if (data.freeTokens !== null) {
    lines.push(row("Free space", formatTokenCount(data.freeTokens)));
  }
  lines.push(row("Compaction buffer", formatTokenCount(data.reserveTokens), "reserved"));
  lines.push(rule);

  // Largest messages
  if (data.largestMessages.length > 0) {
    lines.push(muted(`Largest messages (est):`));
    for (const m of data.largestMessages) {
      const preview = m.preview ? `"${m.preview}"` : "(no text)";
      lines.push(
        dim(m.role.padEnd(10)) +
          dim(preview.slice(0, 32).padEnd(34)) +
          text(formatTokenCount(m.tokens).padStart(8)),
      );
    }
    lines.push(rule);
  }

  // Session totals
  const s = data.session;
  lines.push(
    muted("Session: ") +
      theme.fg("accent", `↑${formatTokenCount(s.input)}`) +
      dim(" ") +
      theme.fg("mdHeading", `↓${formatTokenCount(s.output)}`) +
      dim(" ") +
      theme.fg("mdLink", `↗${formatTokenCount(s.cacheRead)}`) +
      dim(" ") +
      theme.fg("thinkingHigh", `↘${formatTokenCount(s.cacheWrite)}`) +
      dim(" · ") +
      theme.fg("mdHeading", formatUsd(s.cost)),
  );
  lines.push(dim("Estimates use chars/4; the used total comes from the last provider usage."));
  lines.push("");
  lines.push(
    formatStyledKeyHints(theme, [
      ["esc", "close"],
      ["q", "close"],
    ]),
  );

  return lines;
}

// --- Modal ---

/**
 * Frame rows outside the body: top border + bottom border.
 */
const FRAME_BORDER_ROWS = 2;
/**
 * Frame padding rows: 1 above the body + 1 below.
 */
const FRAME_PADDING_ROWS = 2;

/**
 * Show the context breakdown in a framed overlay. Closes on esc, enter, or q.
 */
export async function showContextModal(
  ctx: ExtensionCommandContext,
  breakdown: ContextBreakdown,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      return {
        render(width: number) {
          const rows = tui?.terminal?.rows ?? 0;
          const options: ModalFrameOptions = { title: "Context" };
          if (rows > 0) {
            // Body budget that fits the overlay's maxHeight (80% of terminal
            // rows), minus frame borders and padding, so the bottom border
            // and key hints are never clipped.
            const budget = Math.max(6, Math.floor(rows * 0.8));
            options.fixedBodyRows = Math.max(1, budget - (FRAME_BORDER_ROWS + FRAME_PADDING_ROWS));
          }
          return renderModalFrame(theme, width, buildModalLines(theme, breakdown, width), options);
        },
        invalidate() {},
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "\r" ||
            data.toLowerCase() === "q"
          ) {
            done();
            return;
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: PANEL_OVERLAY_OPTIONS },
  );
}

// --- Plain text ---

/** Plain-text variant for print/json mode, delivered as a session message. */
export function buildPlainText(data: ContextBreakdown): string {
  const lines: string[] = [];
  lines.push(`Model: ${data.modelLabel}`);

  if (data.usedTokens === null || data.contextWindow <= 0) {
    lines.push("Used: (unknown — no assistant usage yet)");
  } else {
    const pct = data.percent ?? (data.usedTokens / data.contextWindow) * 100;
    const freeStr = data.freeTokens !== null ? ` · ${formatTokenCount(data.freeTokens)} free` : "";
    lines.push(
      `Used: ${formatTokenCount(data.usedTokens)} / ${formatTokenCount(data.contextWindow)} (${formatPercent(pct)}${freeStr})`,
    );
  }

  lines.push(`System prompt: ${formatTokenCount(data.systemPromptTokens)} (est)`);
  if (data.contextFiles.length > 0) {
    lines.push(`  Context files (${data.contextFiles.length}):`);
    for (const file of data.contextFiles) {
      lines.push(`    ${file.path}: ${formatTokenCount(file.tokens)}`);
    }
  }
  if (data.skills.length > 0) {
    lines.push(
      `  Skills (${data.skills.length}): ${formatTokenCount(data.skills.reduce((sum, s) => sum + s.tokens, 0))}`,
    );
  }
  lines.push(`  Tools: ${formatTokenCount(data.toolsTokens)} (${data.activeToolCount} active)`);
  lines.push(`Messages: ${formatTokenCount(data.messageTokens)} (${data.messageCount} entries)`);
  if (data.freeTokens !== null) {
    lines.push(`Free space: ${formatTokenCount(data.freeTokens)}`);
  }
  lines.push(`Compaction buffer: ${formatTokenCount(data.reserveTokens)} (reserved)`);

  if (data.largestMessages.length > 0) {
    lines.push("Largest messages (est):");
    for (const m of data.largestMessages) {
      const preview = m.preview ? `"${m.preview}"` : "(no text)";
      lines.push(`  ${m.role.padEnd(10)} ${preview}  ${formatTokenCount(m.tokens)}`);
    }
  }

  const s = data.session;
  lines.push(
    `Session totals: ↑${formatTokenCount(s.input)} ↓${formatTokenCount(s.output)} ↗${formatTokenCount(s.cacheRead)} ↘${formatTokenCount(s.cacheWrite)} · ${formatUsd(s.cost)}`,
  );
  lines.push("Estimates use chars/4; the used total comes from the last provider usage.");
  return lines.join("\n");
}
