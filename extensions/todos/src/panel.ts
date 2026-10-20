/**
 * The /todos panel: a framed overlay listing every item, the same treatment
 * as the context view (70% width, centered, up to 80% of terminal height).
 * Keys: esc/enter/q close, c clears completed items.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PANEL_OVERLAY_OPTIONS } from "../../../lib/overlay-options.ts";
import { getTodoItems, removeCompletedTodoItems, type TodoItem } from "../../../lib/todos.ts";
import { type ModalFrameOptions, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { buildProgressLabel, itemLine, type WidgetTheme } from "./widget.ts";

const PANEL_TITLE = "Todos";
const EMPTY_LINE = "No items yet.";

function buildPanelLines(theme: WidgetTheme, items: TodoItem[]): string[] {
  if (items.length === 0) return [theme.fg("dim", EMPTY_LINE)];
  const lines = items.map((item, index) => itemLine(theme, item, `${index + 1}. `));
  lines.push("");
  lines.push(
    formatStyledKeyHints(theme, [
      ["esc", "close"],
      ["enter", "close"],
      ["c", "clear done"],
    ]),
  );
  return lines;
}

/** Opens the todos panel overlay. Resolves when the user closes it. */
export function showTodosPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  return ctx.ui.custom<void>(
    (tui, theme: WidgetTheme, keybindings, done) => {
      return {
        render(width: number) {
          const items = getTodoItems(pi);
          const options: ModalFrameOptions = { title: PANEL_TITLE };
          if (items.length > 0) options.titleRight = buildProgressLabel(items);
          return renderModalFrame(theme, width, buildPanelLines(theme, items), options);
        },
        invalidate() {},
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.cancel") ||
            data === "\r" ||
            data.toLowerCase() === "q"
          ) {
            done();
            return;
          }
          if (data.toLowerCase() === "c") {
            removeCompletedTodoItems(pi);
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: PANEL_OVERLAY_OPTIONS },
  );
}
