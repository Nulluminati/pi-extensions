/**
 * Priority-ordered widget strip.
 *
 * pi stacks extension widgets per placement (aboveEditor / belowEditor) in
 * Map insertion order, and re-setting an existing key moves it to the end of
 * that order — so live-updating widgets sink below rarely-updated ones and
 * the visual order churns with update frequency. pi exposes no priority API.
 *
 * This module is the fix: extensions register their widgets through
 * setStripWidget() instead of ctx.ui.setWidget() directly. The strip owns a
 * single composite pi widget per placement and re-renders its entries sorted
 * by priority (ascending = higher on screen), so the order is deterministic
 * no matter how often individual widgets update. Child components are cached
 * per entry key and only rebuilt when an entry's factory changes, so
 * per-widget width caches survive strip republishes.
 *
 * The registry is global (Symbol.for) so a /reload re-import cannot lose
 * entries; extensions re-register on session_start anyway, replacing their
 * entry with a fresh instance's factory. pi clears widgets on session reset;
 * the strip re-publishes from the registry on the next registration.
 */

// --- Constants ---

/** Shared priorities so every widget extension agrees on one order.
 *  Ascending = higher on screen; recap is pinned to the top. */
export const WIDGET_PRIORITY = {
  recap: 0,
  workers: 10,
  jobs: 20,
  todos: 30,
  missions: 40,
  autoresearch: 50,
} as const;

export const WIDGET_PRIORITY_RECAP: number = WIDGET_PRIORITY.recap;
export const WIDGET_PRIORITY_WORKERS: number = WIDGET_PRIORITY.workers;
export const WIDGET_PRIORITY_JOBS: number = WIDGET_PRIORITY.jobs;
export const WIDGET_PRIORITY_TODOS: number = WIDGET_PRIORITY.todos;
export const WIDGET_PRIORITY_MISSIONS: number = WIDGET_PRIORITY.missions;
export const WIDGET_PRIORITY_AUTORESEARCH: number = WIDGET_PRIORITY.autoresearch;

export const STRIP_KEY_ABOVE = "widget-strip:above";
export const STRIP_KEY_BELOW = "widget-strip:below";

export type StripPlacement = "aboveEditor" | "belowEditor";

// --- Types ---

/** Shape every strip child must satisfy. */
export interface StripComponentLike {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

export interface StripEntry {
  key: string;
  /** Ascending = higher on screen. Shared constants live in each extension. */
  priority: number;
  /** Component factory, or undefined to remove the entry. Parameters are
   *  never-typed so extension factories with narrower theme types remain
   *  assignable (contravariance); the strip invokes them with what pi gives. */
  factory: ((tui: never, theme: never) => StripComponentLike) | undefined;
}

/** Minimal surface of ctx.ui the strip needs. */
export interface StripUi {
  setWidget(key: string, content: unknown, options?: unknown): void;
}

interface StripState {
  entries: Map<StripPlacement, Map<string, StripEntry>>;
  /** Child components keyed by entry key, preserved across republishes. */
  children: Map<
    StripPlacement,
    Map<string, { factory: NonNullable<StripEntry["factory"]>; component: unknown }>
  >;
  /** Whether the strip pi widget is currently published for a placement. */
  published: Map<StripPlacement, boolean>;
}

// --- State ---

const STATE_KEY = Symbol.for("pi.widget-strip.state");

function state(): StripState {
  const g = globalThis as Record<symbol, StripState | undefined>;
  let current = g[STATE_KEY];
  if (!current) {
    current = { entries: new Map(), children: new Map(), published: new Map() };
    g[STATE_KEY] = current;
  }
  return current;
}

/** Test isolation: drop the global registry. */
export function __resetWidgetStrip(): void {
  delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
}

function stripKey(placement: StripPlacement): string {
  return placement === "belowEditor" ? STRIP_KEY_BELOW : STRIP_KEY_ABOVE;
}

// --- Composite rendering ---

function makeComposite(placement: StripPlacement) {
  return (tui: unknown, theme: unknown) => {
    const s = state();
    const children = s.children.get(placement) ?? new Map();
    const render = (width: number): string[] => {
      const lines: string[] = [];
      const entries = [...(s.entries.get(placement)?.values() ?? [])].sort(
        (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
      );
      for (const entry of entries) {
        if (entry.factory === undefined) continue;
        let child = children.get(entry.key);
        if (!child || child.factory !== entry.factory) {
          const component = (entry.factory as (t: unknown, th: unknown) => StripComponentLike)(
            tui,
            theme,
          );
          if (
            child &&
            typeof (child.component as { dispose?: () => void }).dispose === "function"
          ) {
            (child.component as { dispose(): void }).dispose();
          }
          child = { factory: entry.factory, component };
          children.set(entry.key, child);
        }
        lines.push(...(child.component as { render(width: number): string[] }).render(width));
      }
      return lines;
    };
    return {
      render,
      invalidate() {
        children.clear();
      },
      dispose() {
        children.clear();
      },
    };
  };
}

// --- Registration ---

/**
 * Register (or update, or remove with factory=undefined) an ordered widget
 * entry and republish the strip for its placement. The first entry in a
 * placement publishes the strip pi widget; removing the last one hides it.
 */
export function setStripWidget(ui: StripUi, placement: StripPlacement, entry: StripEntry): void {
  const s = state();
  let entries = s.entries.get(placement);
  if (!entries) {
    entries = new Map();
    s.entries.set(placement, entries);
  }
  if (entry.factory === undefined) {
    entries.delete(entry.key);
  } else {
    entries.set(entry.key, { key: entry.key, priority: entry.priority, factory: entry.factory });
  }

  if (entries.size === 0) {
    if (s.published.get(placement) === true) {
      s.published.set(placement, false);
      ui.setWidget(stripKey(placement), undefined);
    }
    return;
  }
  s.published.set(placement, true);
  ui.setWidget(stripKey(placement), makeComposite(placement));
}
