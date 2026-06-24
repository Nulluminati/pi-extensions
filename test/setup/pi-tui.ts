import { vi } from "vitest";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Mock `Input` widget — tests don't need real cursor / paste / undo, just
 * enough to render a placeholder line and accept any input. The btw overlay
 * uses this for its composer.
 */
class MockInput {
  value = "";
  cursor = 0;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  getValue(): string {
    return this.value;
  }
  setValue(v: string): void {
    this.value = v;
  }
  render(width: number): string[] {
    const visible = this.value.length > 0 ? this.value : "ask a side question…";
    const padded = visible.length >= width ? visible : visible + " ".repeat(width - visible.length);
    return [padded];
  }
  handleInput(data: string): void {
    if (data === "\n" || data === "\r") {
      this.onSubmit?.(this.value);
      return;
    }
    if (data === "\x1b") {
      this.onEscape?.();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      this.value = this.value.slice(0, -1);
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.value += data;
    }
  }
}

/** Mock `Container` — children are rendered in order; render(width) returns combined lines. */
class MockContainer {
  children: Array<{ invalidate: () => void; render: (w: number) => string[] }> = [];
  focused = false;
  addChild(c: { invalidate: () => void; render: (w: number) => string[] }): void {
    this.children.push(c);
  }
  clear(): void {
    this.children = [];
  }
  invalidate(): void {}
  render(width: number): string[] {
    const all: string[] = [];
    for (const c of this.children) {
      for (const line of c.render(width)) {
        all.push(line);
      }
    }
    return all;
  }
}

/** Mock `Text` — just returns its text as a single line. */
class MockText {
  invalidated = false;
  focused = false;
  constructor(
    public text: string,
    _paddingLeft: number,
    _paddingRight: number,
  ) {}
  setText(t: string): void {
    this.text = t;
  }
  render(_width: number): string[] {
    return [this.text];
  }
  invalidate(): void {
    this.invalidated = true;
  }
}

/** Mock `SelectList` — records items/theme and drives selection via onSelect/onCancel. */
class MockSelectList {
  onSelect?: (item: { label: string; description?: string }) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: { label: string; description?: string }) => void;
  invalidated = false;
  constructor(
    public items: Array<{ label: string; description?: string }>,
    public _maxVisible: number,
    public _theme: unknown,
  ) {}
  setFilter(_filter: string): void {}
  setSelectedIndex(_index: number): void {}
  getSelectedItem(): { label: string; description?: string } | null {
    return this.items[0] ?? null;
  }
  invalidate(): void {
    this.invalidated = true;
  }
  render(_width: number): string[] {
    return this.items.map((i) => (i.description ? `${i.label} — ${i.description}` : i.label));
  }
  handleInput(_data: string): void {}
}

/** Mock `Key` helper. */
const MockKey = {
  alt: (k: string) => `alt+${k}`,
  ctrlAlt: (k: string) => `ctrl+alt+${k}`,
  up: "up",
  down: "down",
  pageUp: "pageUp",
  pageDown: "pageDown",
};

/** Mock `matchesKey` — recognizes a few key sequences. */
function mockMatchesKey(data: string, keyId: string): boolean {
  if (keyId === "up") return data === "\x1b[A" || data === "\x1bOA";
  if (keyId === "down") return data === "\x1b[B" || data === "\x1bOB";
  if (keyId === "pageUp") return data === "\x1b[5~" || data === "\x1b[[5~";
  if (keyId === "pageDown") return data === "\x1b[6~" || data === "\x1b[[6~";
  if (keyId.startsWith("alt+/")) return data === "\x1b/";
  if (keyId.startsWith("ctrl+alt+")) return data === `\x1b${keyId.slice("ctrl+alt+".length)}`;
  return false;
}

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (str: string, width: number, ellipsis?: string, pad?: boolean): string => {
    const stripped = str.replace(ANSI_RE, "");
    if (stripped.length <= width) {
      if (pad && stripped.length < width) {
        return str + " ".repeat(width - stripped.length);
      }
      return str;
    }
    const ellip = ellipsis !== undefined ? ellipsis : "…";
    return str.slice(0, width - ellip.length) + ellip;
  },
  visibleWidth: (str: string): number => str.replace(ANSI_RE, "").length,
  wrapTextWithAnsi: (str: string, width: number): string[] => {
    const stripped = str.replace(ANSI_RE, "");
    if (stripped.length <= width) return [str];
    const words = str.split(/(\s+)/);
    const lines: string[] = [];
    let current = "";
    for (const chunk of words) {
      const test = current + chunk;
      const testWidth = test.replace(ANSI_RE, "").length;
      if (testWidth > width && current) {
        lines.push(current.trimEnd());
        current = chunk.trimStart();
      } else {
        current = test;
      }
    }
    if (current.trim()) lines.push(current.trimEnd());
    return lines;
  },
  Input: MockInput,
  Container: MockContainer,
  Text: MockText,
  SelectList: MockSelectList,
  Key: MockKey,
  matchesKey: mockMatchesKey,
}));
