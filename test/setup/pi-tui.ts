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
  invalidate(): void {}
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

/** Mock `Loader` — spinner row like pi's "Thinking..." indicator. */
class MockLoader {
  message: string;
  constructor(
    _ui: unknown,
    _spinnerColorFn: (str: string) => string,
    private messageColorFn: (str: string) => string,
    message = "Loading...",
  ) {
    this.message = message;
  }
  start(): void {}
  stop(): void {}
  setMessage(message: string): void {
    this.message = message;
  }
  render(_width: number): string[] {
    // Mirrors the real Loader: a blank line, then the colored message row.
    return ["", this.messageColorFn(this.message)];
  }
  invalidate(): void {}
}

/** Mock `SelectList` — records items/theme and drives selection via onSelect/onCancel. */
class MockSelectList {
  onSelect?: (item: { value?: string; label: string; description?: string }) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: { value?: string; label: string; description?: string }) => void;
  invalidated = false;
  private selectedIndex = 0;
  constructor(
    public items: Array<{ value?: string; label: string; description?: string }>,
    public _maxVisible: number,
    public _theme: unknown,
  ) {}
  setFilter(_filter: string): void {}
  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }
  getSelectedItem(): { value?: string; label: string; description?: string } | null {
    return this.items[this.selectedIndex] ?? null;
  }
  invalidate(): void {
    this.invalidated = true;
  }
  render(_width: number): string[] {
    if (this.items.length === 0) {
      const theme = this._theme as { noMatch: (text: string) => string };
      return [theme.noMatch("  No matching commands")];
    }
    return this.items.map((i) => (i.description ? `${i.label} — ${i.description}` : i.label));
  }
  handleInput(_data: string): void {}
}

/** Mock `SettingsList` — supports arrow navigation and value cycling. */
class MockSettingsList {
  private selectedIndex = 0;
  constructor(
    public items: Array<{
      id: string;
      label: string;
      description?: string;
      currentValue: string;
      values?: string[];
    }>,
    public _maxVisible: number,
    public _theme: unknown,
    private onChange: (id: string, newValue: string) => void,
    private onCancel: () => void,
  ) {}
  updateValue(id: string, newValue: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) item.currentValue = newValue;
  }
  invalidate(): void {}
  render(_width: number): string[] {
    const lines = this.items.map((item, index) => {
      const cursor = index === this.selectedIndex ? "> " : "  ";
      return `${cursor}${item.label}  ${item.currentValue}`;
    });
    const selected = this.items[this.selectedIndex];
    if (selected?.description) lines.push(selected.description);
    return lines;
  }
  handleInput(data: string): void {
    if (data === "\x1b[A" && this.items.length > 0) {
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
      return;
    }
    if (data === "\x1b[B" && this.items.length > 0) {
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      return;
    }
    if (data === "\x1b") {
      this.onCancel();
      return;
    }
    if (data !== "\r" && data !== "\n" && data !== " ") return;
    const item = this.items[this.selectedIndex];
    if (!item?.values || item.values.length === 0) return;
    const currentIndex = item.values.indexOf(item.currentValue);
    const nextValue = item.values[(currentIndex + 1) % item.values.length];
    if (!nextValue) return;
    item.currentValue = nextValue;
    this.onChange(item.id, nextValue);
  }
}

/** Mock `Key` helper. */
const MockKey = {
  space: "space",
  alt: (k: string) => `alt+${k}`,
  shift: (k: string) => `shift+${k}`,
  ctrlAlt: (k: string) => `ctrl+alt+${k}`,
  up: "up",
  down: "down",
  pageUp: "pageUp",
  pageDown: "pageDown",
};

/** Mock `matchesKey` — recognizes a few key sequences. */
function mockMatchesKey(data: string, keyId: string): boolean {
  if (keyId === "space") return data === " " || data === "space-release";
  if (keyId === "shift+tab") return data === "\x1b[Z" || data === "\x1b[9;2u";
  if (keyId === "up") return data === "\x1b[A" || data === "\x1bOA";
  if (keyId === "down") return data === "\x1b[B" || data === "\x1bOB";
  if (keyId === "pageUp") return data === "\x1b[5~" || data === "\x1b[[5~";
  if (keyId === "pageDown") return data === "\x1b[6~" || data === "\x1b[[6~";
  if (keyId.startsWith("alt+/")) return data === "\x1b/";
  if (keyId.startsWith("ctrl+alt+")) return data === `\x1b${keyId.slice("ctrl+alt+".length)}`;
  return false;
}

vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
  Markdown: (await importOriginal<typeof import("@earendil-works/pi-tui")>()).Markdown,
  fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string): T[] => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const text = getText(item).toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  },
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
    const safeWidth = Math.max(1, width);
    const stripped = str.replace(ANSI_RE, "");
    if (stripped.length <= safeWidth) return [str];
    const words = str.split(/(\s+)/);
    const lines: string[] = [];
    let current = "";
    for (const chunk of words) {
      const test = current + chunk;
      const testWidth = test.replace(ANSI_RE, "").length;
      if (testWidth <= safeWidth) {
        current = test;
        continue;
      }
      if (current) {
        lines.push(current.trimEnd());
        current = "";
      }
      let remaining = chunk.trimStart();
      while (remaining.replace(ANSI_RE, "").length > safeWidth) {
        lines.push(remaining.slice(0, safeWidth));
        remaining = remaining.slice(safeWidth);
      }
      current += remaining;
    }
    if (current.trim()) lines.push(current.trimEnd());
    return lines;
  },
  Input: MockInput,
  Container: MockContainer,
  Text: MockText,
  Loader: MockLoader,
  SelectList: MockSelectList,
  SettingsList: MockSettingsList,
  Key: MockKey,
  matchesKey: mockMatchesKey,
  isKeyRelease: vi.fn((data: string) => data === "space-release"),
  isKeyRepeat: vi.fn(() => false),
  isKittyProtocolActive: vi.fn(() => false),
}));
