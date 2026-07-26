import { vi } from "vitest";

/**
 * Mock `@earendil-works/pi-coding-agent` — the package is a peer dependency
 * not installed in the local node_modules, so tests stub it. Only the surface
 * the status-bar extension imports is needed: `CustomEditor`, which the
 * polished editor subclasses. The class is never instantiated in tests (the
 * editor factory is registered but not invoked), so stub methods are placeholders.
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
  return {
    CustomEditor,
    DynamicBorder,
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
