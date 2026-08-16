/**
 * Plan approval prompt: the proposed plan with key hints for approving or
 * keeping planning. Renders in the editor slot (not an overlay), matching
 * pi's other blocking prompts.
 */

import type { ExtensionUIContext } from "pi";
import { renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { formatPlanText } from "./prompts.ts";
import type { Plan } from "./types.ts";

export type PlanApprovalChoice = "approve" | "cancel";

interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

// Raw scroll keys mirroring the jobs panel. The keybinding manager path
// resolves every byte variant of the arrows; these cover environments
// without a manager (tests) and the j/k aliases pi does not bind by default.
const RAW_SCROLL = {
  up: (data: string) => data === "k" || data === "\u001b[A" || data === "\u001bOA",
  down: (data: string) => data === "j" || data === "\u001b[B" || data === "\u001bOB",
};

function matchesScroll(data: string, keybindings: KeybindingsLike, action: "up" | "down"): boolean {
  if (keybindings.matches(data, action === "up" ? "tui.select.up" : "tui.select.down")) {
    return true;
  }
  return RAW_SCROLL[action](data);
}

/**
 * Slice the plan body down to the visible window, marking scrolled-off rows
 * with dim overflow indicators at the window edges (jobs panel style).
 */
function windowPlanLines(
  lines: string[],
  offset: number,
  budget: number,
  dim: (text: string) => string,
): string[] {
  if (lines.length <= budget) return lines;
  const window = lines.slice(offset, offset + budget);
  const belowCount = lines.length - (offset + budget);
  if (offset > 0) {
    window[0] = dim(`↑ ${offset} more line${offset === 1 ? "" : "s"}`);
  }
  if (belowCount > 0) {
    window[window.length - 1] = dim(`↓ ${belowCount} more line${belowCount === 1 ? "" : "s"}`);
  }
  return window;
}

/**
 * Shows the plan in a framed prompt sized to its content. Plans taller than
 * the terminal scroll line-by-line with the arrow keys or j/k; the hints
 * stay pinned below the window. Resolves with the user's choice, or
 * undefined when the dialog cannot run (for example RPC mode).
 */
export async function promptPlanApproval(
  ui: ExtensionUIContext,
  plan: Plan,
): Promise<PlanApprovalChoice | undefined> {
  const body = formatPlanText(plan).split("\n");
  let scrollOffset = 0;
  const result = await ui.custom<PlanApprovalChoice>((tui, theme, keybindings, done) => {
    // The frame adds 4 rows (borders + padding) and the blank + hints add 2;
    // leave 2 more so the prompt never fills the window.
    const budget = (): number => {
      const rows = tui?.terminal?.rows ?? 0;
      return rows > 0 ? Math.max(2, rows - 8) : body.length;
    };
    const maxOffset = (): number => Math.max(0, body.length - budget());
    return {
      render(width: number) {
        const hints = formatStyledKeyHints(theme, [
          ["enter", "approve & execute"],
          ["esc", "keep planning"],
        ]);
        const planLines = windowPlanLines(body, scrollOffset, budget(), (text) =>
          theme.fg("dim", text),
        );
        return renderModalFrame(theme, width, [...planLines, "", hints], {
          title: "Approve plan?",
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.confirm")) {
          done("approve");
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          done("cancel");
          return;
        }
        if (matchesScroll(data, keybindings, "up")) {
          scrollOffset = Math.max(0, scrollOffset - 1);
        } else if (matchesScroll(data, keybindings, "down")) {
          scrollOffset = Math.min(maxOffset(), scrollOffset + 1);
        }
        tui.requestRender();
      },
    };
  });

  return result as PlanApprovalChoice | undefined;
}
