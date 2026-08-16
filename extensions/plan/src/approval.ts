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

/**
 * Shows the plan in a framed prompt sized to its content. A plan that would
 * push the frame plus hints past the terminal clips its steps with a
 * "↓ N more lines" indicator; the hints stay pinned as the last line.
 * Resolves with the user's choice, or undefined when the dialog cannot run
 * (for example RPC mode).
 */
export async function promptPlanApproval(
  ui: ExtensionUIContext,
  plan: Plan,
): Promise<PlanApprovalChoice | undefined> {
  const body = formatPlanText(plan).split("\n");
  const result = await ui.custom<PlanApprovalChoice>((tui, theme, keybindings, done) => {
    return {
      render(width: number) {
        const hints = formatStyledKeyHints(theme, [
          ["enter", "approve & execute"],
          ["esc", "keep planning"],
        ]);
        // The frame adds 4 rows (borders + padding) and the blank + hints add
        // 2; leave 2 more so the prompt never fills the window.
        let planLines = body;
        const rows = tui?.terminal?.rows ?? 0;
        if (rows > 0) {
          const planBudget = Math.max(2, rows - 8);
          if (planLines.length > planBudget) {
            const hidden = planLines.length - planBudget + 1;
            planLines = [
              ...planLines.slice(0, planBudget - 1),
              theme.fg("dim", `↓ ${hidden} more line${hidden === 1 ? "" : "s"}`),
            ];
          }
        }
        return renderModalFrame(theme, width, [...planLines, "", hints], {
          title: "Approve plan?",
        });
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.confirm")) {
          done("approve");
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done("cancel");
        }
        tui.requestRender();
      },
    };
  });

  return result as PlanApprovalChoice | undefined;
}
