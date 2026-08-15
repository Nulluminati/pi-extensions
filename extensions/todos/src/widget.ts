/** Widget line rendering for the todo list. Pure function, tested directly. */

import type { TodoItem } from "../../../lib/todos.ts";

export interface WidgetTheme {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

/** Renders the todo list as ☐/☑ lines for the editor widget. */
export function buildWidgetLines(theme: WidgetTheme, items: TodoItem[]): string[] {
  return items.map((item) =>
    item.completed
      ? theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(item.text))
      : theme.fg("muted", "☐ ") + item.text,
  );
}
