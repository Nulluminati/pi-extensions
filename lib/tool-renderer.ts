/** Shared primitives for compact Pi tool result renderers. */

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface ToolTheme {
  fg(color: string, text: string): string;
}

export interface ToolRenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

export function createToolStatus(
  theme: ToolTheme,
  color: string,
  text: string,
): ToolRenderComponent {
  return {
    render: (width) => [truncateToWidth(theme.fg(color, text), width)],
    invalidate: () => {},
  };
}

export function wrapToolText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") lines.push("");
    else lines.push(...wrapTextWithAnsi(paragraph, width));
  }
  return lines;
}
