import { truncateToWidth } from "@earendil-works/pi-tui";

export interface FrameTheme {
  fg(color: string, text: string): string;
}

export type FrameEdge = "top" | "bottom";

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.floor(width));
}

function frameGlyphs(width: number, left: string, fill: string, right: string): string {
  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) return "";
  if (safeWidth === 1) return left;
  return `${left}${fill.repeat(safeWidth - 2)}${right}`;
}

export function frameContentLine(theme: FrameTheme, width: number, content: string): string {
  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) return "";
  if (safeWidth === 1) return theme.fg("border", "│");
  if (safeWidth === 2) return theme.fg("border", "││");

  const inner = truncateToWidth(content, safeWidth - 2, "…", true);
  return theme.fg("border", "│") + inner + theme.fg("border", "│");
}

export function frameRuleLine(theme: FrameTheme, width: number): string {
  const line = frameGlyphs(width, "├", "─", "┤");
  return line ? theme.fg("border", line) : "";
}

export function frameBorderLine(theme: FrameTheme, width: number, edge: FrameEdge): string {
  const left = edge === "top" ? "╭" : "╰";
  const right = edge === "top" ? "╮" : "╯";
  const line = frameGlyphs(width, left, "─", right);
  return line ? theme.fg("border", line) : "";
}
