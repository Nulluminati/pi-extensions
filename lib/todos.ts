/**
 * Shared todo-list store for Pi extensions.
 *
 * Owns per-instance todo state (keyed by the ExtensionAPI), persists it as a
 * "todos-state" session entry, and publishes every change on the pi.events
 * bus as "todos:changed". The todos extension registers the `todo` tool, the
 * widget, and the /todos commands; other extensions (for example plan) read
 * or replace the list through this module without depending on that
 * extension, so plan keeps working when todos is not loaded.
 */

import type { ExtensionAPI } from "pi";

export const TODOS_ENTRY_TYPE = "todos-state";
export const TODOS_CHANGED_EVENT = "todos:changed";

export interface TodoItem {
  text: string;
  completed: boolean;
}

interface TodosStore {
  items: TodoItem[];
}

const stores = new WeakMap<ExtensionAPI, TodosStore>();

function getStore(pi: ExtensionAPI): TodosStore {
  let store = stores.get(pi);
  if (!store) {
    store = { items: [] };
    stores.set(pi, store);
  }
  return store;
}

function isValidItem(value: unknown): value is TodoItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TodoItem).text === "string" &&
    typeof (value as TodoItem).completed === "boolean"
  );
}

function persist(pi: ExtensionAPI, items: TodoItem[]): void {
  pi.appendEntry(TODOS_ENTRY_TYPE, { items });
}

function publish(pi: ExtensionAPI, items: TodoItem[]): void {
  pi.events.emit(TODOS_CHANGED_EVENT, { items });
}

/** Current todo list (ordered as displayed). */
export function getTodoItems(pi: ExtensionAPI): TodoItem[] {
  return getStore(pi).items;
}

/** Replaces the whole list (used by plan when a plan is approved). */
export function setTodoItems(pi: ExtensionAPI, texts: string[]): void {
  const store = getStore(pi);
  store.items = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, completed: false }));
  persist(pi, store.items);
  publish(pi, store.items);
}

/** Appends items; returns how many were added. */
export function addTodoItems(pi: ExtensionAPI, texts: string[]): number {
  const store = getStore(pi);
  const added = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, completed: false }));
  store.items.push(...added);
  if (added.length > 0) {
    persist(pi, store.items);
    publish(pi, store.items);
  }
  return added.length;
}

/**
 * Marks items complete or incomplete by 1-based index (matching the displayed
 * list). Returns how many items changed state.
 */
export function markTodoItems(pi: ExtensionAPI, indices: number[], completed: boolean): number {
  const store = getStore(pi);
  let matched = 0;
  for (const index of indices) {
    const item = store.items[index - 1];
    if (item && item.completed !== completed) {
      item.completed = completed;
      matched++;
    }
  }
  if (matched > 0) {
    persist(pi, store.items);
    publish(pi, store.items);
  }
  return matched;
}

/** Clears the list. */
export function clearTodoItems(pi: ExtensionAPI): void {
  const store = getStore(pi);
  if (store.items.length === 0) return;
  store.items = [];
  persist(pi, store.items);
  publish(pi, store.items);
}

/**
 * Rebuilds the store from session entries (the last persisted snapshot wins,
 * matching how pi appends entries over time). Call from session_start and
 * session_tree handlers; idempotent, safe to call from several extensions.
 */
export function reconstructTodos(pi: ExtensionAPI, entries: unknown[]): TodoItem[] {
  const store = getStore(pi);
  store.items = [];
  for (const entry of entries as Array<{ type?: string; customType?: string; data?: unknown }>) {
    if (entry?.type !== "custom" || entry.customType !== TODOS_ENTRY_TYPE) continue;
    const data = entry.data as { items?: unknown } | undefined;
    if (Array.isArray(data?.items)) {
      store.items = data.items.filter(isValidItem).map((item) => ({ ...item }));
    }
  }
  return store.items;
}
