/** Widget rendering for the todo list: pure line building plus the framed
 * editor-widget factory. Tested directly and through the extension. */

import type { ExtensionAPI } from "pi";
import { getTodoItems, type TodoItem } from "../../../lib/todos.ts";
import { renderModalFrame } from "../../../lib/tui-frame.ts";

/** How many items the widget shows before collapsing the rest. */
const MAX_WIDGET_ITEMS = 3;

const WIDGET_TITLE = "Todos";

export interface WidgetTheme {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

/** One ☐/☑ line; prefix carries the 1-based number in the panel. */
export function itemLine(theme: WidgetTheme, item: TodoItem, prefix = ""): string {
  return item.completed
    ? theme.fg("success", `${prefix}☑ `) + theme.fg("muted", theme.strikethrough(item.text))
    : theme.fg("muted", `${prefix}☐ `) + item.text;
}

/** Progress label for the frame's top-right cell, e.g. "2/5 done". */
export function buildProgressLabel(items: TodoItem[]): string {
  const done = items.filter((item) => item.completed).length;
  return `${done}/${items.length} done`;
}

/**
 * Widget body lines: open items only (the widget is about what's left to
 * do); when everything is complete the finished items stay visible. Shows at
 * most maxItems lines plus a "↓ N more" indicator.
 */
export function buildWidgetLines(
  theme: WidgetTheme,
  items: TodoItem[],
  maxItems = MAX_WIDGET_ITEMS,
): string[] {
  const open = items.filter((item) => !item.completed);
  const visibleSource = open.length > 0 ? open : items;
  const visible = visibleSource.slice(0, maxItems);
  const hidden = visibleSource.length - visible.length;
  const lines = visible.map((item) => itemLine(theme, item));
  if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
  return lines;
}

/**
 * Editor-widget factory: the todo list in a framed box above the editor, the
 * same border language as modal panels. Items are read at render time, so
 * the box always shows the current list.
 */
export function createTodosWidget(pi: ExtensionAPI) {
  return (_tui: unknown, theme: WidgetTheme) => {
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;
    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        const items = getTodoItems(pi);
        cachedLines = renderModalFrame(theme, width, buildWidgetLines(theme, items), {
          title: WIDGET_TITLE,
          titleRight: buildProgressLabel(items),
          paddingY: 0,
        });
        cachedWidth = width;
        return cachedLines;
      },
      invalidate(): void {
        cachedWidth = undefined;
        cachedLines = undefined;
      },
    };
  };
}
