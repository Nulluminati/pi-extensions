/** Pi-style text rendering and bounded transcript scrolling. */

import { stripVTControlCharacters } from "node:util";
import { Markdown, type MarkdownTheme, ScrollView } from "@earendil-works/pi-tui";
import { wrapToolText } from "../../../lib/tool-renderer.ts";
import type { TranscriptBlock } from "./transcript-events.ts";
import { workerViewTheme as theme } from "./worker-cards.ts";

export function cleanTranscriptText(text: string): string {
  // Preserve text layout, but never let artifact content control the terminal.
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === "\n" ? "\n" : character === "\t" ? "  " : "",
  );
}

const color = (name: string) => (text: string) => theme.fg(name, text);
const markdownTheme: MarkdownTheme = {
  heading: color("accent"),
  link: color("accent"),
  linkUrl: color("dim"),
  code: color("accent"),
  codeBlock: color("text"),
  codeBlockBorder: color("dim"),
  quote: color("muted"),
  quoteBorder: color("dim"),
  hr: color("dim"),
  listBullet: color("accent"),
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
  italic: (text) => `\u001b[3m${text}\u001b[23m`,
  strikethrough: (text) => `\u001b[9m${text}\u001b[29m`,
  underline: (text) => `\u001b[4m${text}\u001b[24m`,
};

export function renderTranscriptBlocks(
  blocks: readonly TranscriptBlock[],
  width: number,
): string[] {
  const lines: string[] = [];
  const safeWidth = Math.max(1, width);
  for (const block of blocks) {
    const tool = cleanTranscriptText(block.toolName ?? "Tool");
    const [heading, shade] =
      block.kind === "tool_call"
        ? [`▸ ${tool}`, "accent"]
        : block.kind === "tool_result"
          ? [`${block.isError ? "✗" : "✓"} ${tool}`, block.isError ? "error" : "success"]
          : block.kind === "user"
            ? ["Task", "accent"]
            : block.kind === "assistant"
              ? ["Assistant", "accent"]
              : block.kind === "thinking"
                ? ["Thinking", "dim"]
                : block.kind === "error"
                  ? ["Error", "error"]
                  : ["Worker", "muted"];
    if (lines.length) lines.push("");
    lines.push(...wrapToolText(theme.fg(shade ?? "muted", heading ?? "Worker"), safeWidth));
    const text = cleanTranscriptText(block.text);
    if (block.kind === "assistant" || block.kind === "user")
      lines.push(...new Markdown(text, 0, 0, markdownTheme).render(safeWidth));
    else
      lines.push(
        ...wrapToolText(block.kind === "thinking" ? theme.fg("dim", text) : text, safeWidth),
      );
    if (block.details)
      lines.push(...wrapToolText(theme.fg("dim", cleanTranscriptText(block.details)), safeWidth));
  }
  return lines;
}

export function createTranscriptViewport() {
  let blocks: readonly TranscriptBlock[] = [];
  let cachedWidth = -1;
  let cachedLines: string[] = [];
  const document = {
    render(width: number): string[] {
      if (width !== cachedWidth) {
        cachedLines = renderTranscriptBlocks(blocks, width);
        cachedWidth = width;
      }
      return cachedLines;
    },
    invalidate(): void {
      cachedWidth = -1;
    },
  };
  const scroll = new ScrollView(document, { follow: "end", scrollbar: "hidden" });
  return {
    setBlocks(value: readonly TranscriptBlock[]): void {
      blocks = value;
      document.invalidate();
    },
    render(width: number, height: number): string[] {
      const lines = scroll.render(Math.max(1, width));
      const rows = Math.max(1, height);
      scroll.updateLayout(lines.length, rows, () => {});
      return lines.slice(scroll.scrollTop, scroll.scrollTop + rows);
    },
    scrollBy(lines: number): number {
      return scroll.scrollBy(lines);
    },
    scrollToStart(): void {
      scroll.scrollToStart();
    },
    scrollToEnd(): void {
      scroll.scrollToEnd();
    },
    pauseAtEnd(): void {
      scroll.scrollTo(Number.MAX_SAFE_INTEGER, { disableFollow: true });
    },
    get following(): boolean {
      return scroll.isFollowingEnd;
    },
    get scrollTop(): number {
      return scroll.scrollTop;
    },
  };
}
