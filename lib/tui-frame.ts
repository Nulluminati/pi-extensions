import { truncateToWidth } from "@earendil-works/pi-tui";

export interface FrameTheme {
  fg(color: string, text: string): string;
}

export interface ModalFrameOptions {
  title: string;
  paddingX?: number;
  paddingY?: number;
  fixedBodyRows?: number;
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

export function modalContentWidth(width: number, paddingX = 2): number {
  return Math.max(1, normalizeWidth(width) - 2 - Math.max(0, paddingX) * 2);
}

export function renderModalFrame(
  theme: FrameTheme,
  width: number,
  lines: string[],
  options: ModalFrameOptions,
): string[] {
  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) return [];
  if (safeWidth < 4) {
    return lines.map((line) => truncateToWidth(line, safeWidth, ""));
  }

  const paddingX = Math.max(0, options.paddingX ?? 2);
  const paddingY = Math.max(0, options.paddingY ?? 1);
  const innerWidth = safeWidth - 2;
  const contentWidth = modalContentWidth(safeWidth, paddingX);
  const border = (text: string) => theme.fg("borderAccent", text);
  const title = truncateToWidth(options.title, Math.max(1, innerWidth - 4), "…");
  const titleCell = ` ${title} `;
  const leftRuleWidth = Math.min(2, Math.max(0, innerWidth - titleCell.length));
  const rightRuleWidth = Math.max(0, innerWidth - leftRuleWidth - titleCell.length);
  const top = `${border("╭")}${border("─".repeat(leftRuleWidth))}${theme.fg("accent", titleCell)}${border("─".repeat(rightRuleWidth))}${border("╮")}`;
  const blank = `${border("│")}${" ".repeat(innerWidth)}${border("│")}`;

  let body = [...lines];
  if (options.fixedBodyRows !== undefined) {
    const fixedRows = Math.max(1, options.fixedBodyRows);
    if (body.length > fixedRows) {
      const hidden = body.length - fixedRows + 1;
      body = [
        ...body.slice(0, fixedRows - 1),
        theme.fg("dim", `↓ ${hidden} more line${hidden === 1 ? "" : "s"}`),
      ];
    }
    while (body.length < fixedRows) body.push("");
  }

  const output = [top];
  for (let index = 0; index < paddingY; index++) output.push(blank);
  for (const line of body) {
    const content = truncateToWidth(line, contentWidth, "…", true);
    output.push(
      `${border("│")}${" ".repeat(paddingX)}${content}${" ".repeat(paddingX)}${border("│")}`,
    );
  }
  for (let index = 0; index < paddingY; index++) output.push(blank);
  output.push(`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
  return output.map((line) => truncateToWidth(line, safeWidth, ""));
}

export function frameBorderLine(theme: FrameTheme, width: number, edge: FrameEdge): string {
  const left = edge === "top" ? "╭" : "╰";
  const right = edge === "top" ? "╮" : "╯";
  const line = frameGlyphs(width, left, "─", right);
  return line ? theme.fg("border", line) : "";
}
