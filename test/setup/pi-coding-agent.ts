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
  return {
    BashExecutionComponent,
    CustomEditor,
    CustomMessageComponent,
    DynamicBorder,
    Theme,
    ToolExecutionComponent,
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
