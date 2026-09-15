import { vi } from "vitest";

/**
 * Mock `@earendil-works/pi-coding-agent` — the package is a peer dependency
 * not installed in the local node_modules, so tests stub the component surface
 * used by extensions in this repository.
 */
vi.mock("@earendil-works/pi-coding-agent", () => {
  class CustomEditor {
    borderColor?: ((str: string) => string) | undefined;
    focused = false;
    // Mirrors the base Editor's prompt history (newest first, cap 100,
    // consecutive duplicates skipped) so editor-swap and history tests run
    // against the real semantics.
    history: string[] = [];
    addToHistory(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (this.history[0] === trimmed) return;
      this.history.unshift(trimmed);
      if (this.history.length > 100) this.history.length = 100;
    }
    // Minimal base-editor output: top border, one content line, bottom
    // border. Enough for PolishedEditor.render to run its framing logic so
    // tests can assert the model/thinking metadata line is produced.
    render(width: number): string[] {
      const bar = "─".repeat(Math.max(0, width));
      return [bar, "", bar];
    }
    invalidate(): void {}
    handleInput(_data: string): void {}
    getText(): string {
      return "";
    }
    setText(_text: string): void {}
  }
  class DynamicBorder {
    invalidated = false;
    private color?: ((str: string) => string) | undefined;
    constructor(color?: ((str: string) => string) | undefined) {
      this.color = color;
    }
    invalidate(): void {
      this.invalidated = true;
    }
    render(width: number): string[] {
      const bar = "─".repeat(Math.max(0, width));
      return [this.color ? this.color(bar) : bar];
    }
  }
  class RenderedComponent {
    lines = ["", "content"];
    renderedWidth = 0;
    render(width: number): string[] {
      this.renderedWidth = width;
      return this.lines.map((line) => line.slice(0, Math.max(0, width)));
    }
  }
  class Theme {
    bg(color: string, text: string): string {
      return `<theme-bg:${color}>${text}</theme-bg:${color}>`;
    }
    getBgAnsi(color: string): string {
      return `<theme-bg:${color}>`;
    }
  }
  class ToolExecutionComponent extends RenderedComponent {
    isPartial = true;
    result?: { isError?: boolean };
  }
  class BashExecutionComponent extends RenderedComponent {
    status: "running" | "complete" | "error" | "cancelled" = "running";
  }
  class CustomMessageComponent extends RenderedComponent {}
  // Mirrors pi's chars/4 heuristic (see estimateTokens in the real package):
  // text blocks count chars/4, images count as 4800 chars each.
  const estimateTokens = vi.fn((message: any) => {
    let chars = 0;
    const content = message?.content;
    if (typeof content === "string") {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          chars += block.text.length;
        } else if (block?.type === "image") {
          chars += 4800;
        }
      }
    }
    return Math.max(0, Math.ceil(chars / 4));
  });
  return {
    BashExecutionComponent,
    CustomEditor,
    CustomMessageComponent,
    DynamicBorder,
    Theme,
    ToolExecutionComponent,
    CONFIG_DIR_NAME: ".pi",
    DEFAULT_COMPACTION_SETTINGS: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    },
    estimateTokens,
    getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
    getSettingsListTheme: vi.fn(() => ({
      label: (text: string) => text,
      value: (text: string) => text,
      description: (text: string) => text,
      cursor: "> ",
      hint: (text: string) => text,
    })),
  };
});
