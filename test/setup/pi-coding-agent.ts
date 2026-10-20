import { vi } from "vitest";

/**
 * Unit tests use the real `@earendil-works/pi-coding-agent` exports except
 * the stubs below. Each stub stays because the real export cannot run in a
 * unit test:
 *
 * - The interactive components (`CustomEditor`, `ToolExecutionComponent`,
 *   `BashExecutionComponent`, `CustomMessageComponent`) and `Theme` need a
 *   live TUI and the global theme from `initTheme()`. The runtime suite
 *   covers the real classes (test/runtime/pi-tool-style.test.ts).
 * - `getSettingsListTheme` reads the global theme from `initTheme()`.
 * - `getAgentDir` points at a fixed fake directory so no unit test reads or
 *   writes the real `~/.pi`; tests redirect it with `vi.mocked(getAgentDir)`.
 */
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
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
    ...actual,
    BashExecutionComponent,
    CustomEditor,
    CustomMessageComponent,
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
