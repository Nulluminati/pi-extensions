import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetWidgetStrip,
  STRIP_KEY_ABOVE,
  STRIP_KEY_BELOW,
  setStripWidget,
} from "../../lib/widget-strip.ts";

interface MockTheme {
  fg: (color: string, text: string) => string;
}

const theme: MockTheme = { fg: (_c, text) => text };

interface TestComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** Mock pi UI capturing setWidget calls like createMockPi does. */
function createMockUi() {
  const calls: Array<{ key: string; content: unknown; options?: unknown }> = [];
  return {
    setWidget: (key: string, content: unknown, options?: unknown) => {
      calls.push({ key, content, options });
    },
    calls,
  };
}
type MockUi = ReturnType<typeof createMockUi>;

/** Render the LAST strip composite the mock ui received for a placement. */
function renderStrip(ui: MockUi, key: string, width = 80): string[] {
  const call = ui.calls.filter((c) => c.key === key).at(-1);
  if (!call || typeof call.content !== "function") return [];
  const component = (call.content as (tui: unknown, theme: unknown) => TestComponent)(
    undefined,
    theme,
  );
  return component.render(width);
}

function lineFactory(text: string) {
  return () => ({
    render: (width: number) => [`${text} (${width})`],
    invalidate: () => {},
  });
}

interface CompositeLike {
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

/** Build the LAST strip composite the mock ui received for a placement. */
function lastComposite(ui: MockUi, key: string): CompositeLike {
  const call = ui.calls.filter((c) => c.key === key).at(-1);
  if (!call || typeof call.content !== "function") throw new Error(`no composite for ${key}`);
  return (call.content as (tui: unknown, theme: unknown) => CompositeLike)(undefined, theme);
}

describe("widget-strip", () => {
  beforeEach(() => {
    __resetWidgetStrip();
  });

  it("renders entries in priority order regardless of registration order", () => {
    const ui = createMockUi();
    setStripWidget(ui, "aboveEditor", {
      key: "workers",
      priority: 10,
      factory: lineFactory("workers"),
    });
    setStripWidget(ui, "aboveEditor", { key: "recap", priority: 0, factory: lineFactory("recap") });

    const text = renderStrip(ui, STRIP_KEY_ABOVE);
    expect(text.indexOf("recap (80)")).toBeLessThan(text.indexOf("workers (80)"));
  });

  it("publishes the strip widget once entries exist and hides it when empty", () => {
    const ui = createMockUi();
    // Nothing registered yet: no strip widget published for this placement.
    setStripWidget(ui, "aboveEditor", { key: "jobs", priority: 20, factory: undefined });
    expect(ui.calls.filter((c) => c.key === STRIP_KEY_ABOVE)).toHaveLength(0);

    setStripWidget(ui, "aboveEditor", { key: "jobs", priority: 20, factory: lineFactory("jobs") });
    expect(renderStrip(ui, STRIP_KEY_ABOVE)).toContain("jobs (80)");

    // Removing the last entry hides the pi widget again.
    setStripWidget(ui, "aboveEditor", { key: "jobs", priority: 20, factory: undefined });
    const last = ui.calls.filter((c) => c.key === STRIP_KEY_ABOVE).at(-1);
    expect(last?.content).toBeUndefined();
  });

  it("replacing an entry's factory swaps its component without touching order", () => {
    const ui = createMockUi();
    setStripWidget(ui, "aboveEditor", {
      key: "recap",
      priority: 0,
      factory: lineFactory("recap-v1"),
    });
    setStripWidget(ui, "aboveEditor", {
      key: "workers",
      priority: 10,
      factory: lineFactory("workers"),
    });

    setStripWidget(ui, "aboveEditor", {
      key: "recap",
      priority: 0,
      factory: lineFactory("recap-v2"),
    });

    const text = renderStrip(ui, STRIP_KEY_ABOVE);
    const recapAt = text.indexOf("recap-v2 (80)");
    const workersAt = text.indexOf("workers (80)");
    expect(recapAt).toBeGreaterThanOrEqual(0);
    expect(recapAt).toBeLessThan(workersAt);
    expect(text).not.toContain("recap-v1");
  });

  it("separates placements: a below-editor entry never shows in the above strip", () => {
    const ui = createMockUi();
    setStripWidget(ui, "aboveEditor", { key: "recap", priority: 0, factory: lineFactory("recap") });
    setStripWidget(ui, "belowEditor", { key: "jobs", priority: 10, factory: lineFactory("jobs") });

    expect(renderStrip(ui, STRIP_KEY_ABOVE)).toContain("recap (80)");
    expect(renderStrip(ui, STRIP_KEY_BELOW)).toContain("jobs (80)");
    expect(renderStrip(ui, STRIP_KEY_ABOVE)).not.toContain("jobs (80)");
  });

  it("keeps child components (and their caches) across strip republishes", () => {
    const ui = createMockUi();
    let builds = 0;
    const factory = () => {
      builds += 1;
      return { render: () => ["body"], invalidate: () => {} };
    };
    setStripWidget(ui, "aboveEditor", { key: "workers", priority: 10, factory });

    // The first render builds the child once; the children map must persist
    // in shared state so later composites reuse it.
    renderStrip(ui, STRIP_KEY_ABOVE);
    const before = builds;
    // A different entry changing republishes the strip but must not rebuild
    // the untouched worker component.
    setStripWidget(ui, "aboveEditor", { key: "recap", priority: 0, factory: lineFactory("recap") });
    renderStrip(ui, STRIP_KEY_ABOVE);
    renderStrip(ui, STRIP_KEY_ABOVE);
    expect(builds).toBe(before);
  });

  it("disposes cached children when the strip is invalidated", () => {
    const ui = createMockUi();
    const disposed: string[] = [];
    let builds = 0;
    const factory = () => {
      builds += 1;
      return {
        render: () => ["body"],
        invalidate: () => {},
        dispose: () => disposed.push("workers"),
      };
    };
    setStripWidget(ui, "aboveEditor", { key: "workers", priority: 10, factory });
    renderStrip(ui, STRIP_KEY_ABOVE);
    expect(builds).toBe(1);

    const composite = lastComposite(ui, STRIP_KEY_ABOVE);
    composite.invalidate();
    expect(disposed).toEqual(["workers"]);

    // The next render rebuilds the disposed child fresh.
    renderStrip(ui, STRIP_KEY_ABOVE);
    expect(builds).toBe(2);
  });

  it("disposes and drops the cached child when its entry is removed", () => {
    const ui = createMockUi();
    const disposed: string[] = [];
    let builds = 0;
    const factory = () => {
      builds += 1;
      return {
        render: () => ["body"],
        invalidate: () => {},
        dispose: () => disposed.push("workers"),
      };
    };
    setStripWidget(ui, "aboveEditor", { key: "workers", priority: 10, factory });
    renderStrip(ui, STRIP_KEY_ABOVE);
    expect(builds).toBe(1);

    setStripWidget(ui, "aboveEditor", { key: "workers", priority: 10, factory: undefined });
    expect(disposed).toEqual(["workers"]);

    // Re-registering the same factory must build a fresh component: the
    // cached child was disposed and dropped with the entry.
    setStripWidget(ui, "aboveEditor", { key: "workers", priority: 10, factory });
    renderStrip(ui, STRIP_KEY_ABOVE);
    expect(builds).toBe(2);
  });

  it("dispose() disposes every cached child", () => {
    const ui = createMockUi();
    const disposed: string[] = [];
    const disposeFactory = (name: string) => () => ({
      render: () => [name],
      invalidate: () => {},
      dispose: () => disposed.push(name),
    });
    setStripWidget(ui, "aboveEditor", {
      key: "workers",
      priority: 10,
      factory: disposeFactory("workers"),
    });
    setStripWidget(ui, "aboveEditor", {
      key: "recap",
      priority: 0,
      factory: disposeFactory("recap"),
    });
    renderStrip(ui, STRIP_KEY_ABOVE);

    lastComposite(ui, STRIP_KEY_ABOVE).dispose();
    expect(disposed.sort()).toEqual(["recap", "workers"]);
  });

  it("survives re-registration after a ui reset (reload)", () => {
    const uiA = createMockUi();
    setStripWidget(uiA, "aboveEditor", {
      key: "recap",
      priority: 0,
      factory: lineFactory("recap"),
    });

    // pi clears widgets on session reset; the registry persists so the next
    // registration (fresh extension instance) restores the entry.
    const uiB = createMockUi();
    setStripWidget(uiB, "aboveEditor", {
      key: "recap",
      priority: 0,
      factory: lineFactory("recap-v3"),
    });

    // The registry survived the ui reset; the fresh instance's entry replaces
    // the old one and the strip re-publishes with the new factory.
    expect(renderStrip(uiB, STRIP_KEY_ABOVE)).toContain("recap-v3 (80)");
  });
});
