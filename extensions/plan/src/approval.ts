/**
 * Plan approval modal: an overlay showing the proposed plan with key hints
 * for approving, sending it back for discussion, or keeping planning.
 */

import type { ExtensionUIContext } from "pi";
import { renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { formatPlanText } from "./prompts.ts";
import type { Plan } from "./types.ts";

export type PlanApprovalChoice = "approve" | "discuss" | "cancel";

/**
 * Shows the plan in a framed overlay. Resolves with the user's choice, or
 * undefined when the dialog cannot run (for example RPC mode).
 */
export async function promptPlanApproval(
  ui: ExtensionUIContext,
  plan: Plan,
): Promise<PlanApprovalChoice | undefined> {
  const body = formatPlanText(plan).split("\n");
  const result = await ui.custom<PlanApprovalChoice>(
    (tui, theme, keybindings, done) => {
      return {
        render(width: number) {
          const lines = [
            ...body,
            "",
            formatStyledKeyHints(theme, [
              ["enter", "approve & execute"],
              ["d", "keep discussing"],
              ["esc", "keep planning"],
            ]),
          ];
          return renderModalFrame(theme, width, lines, { title: "Approve plan?" });
        },
        invalidate() {},
        handleInput(data: string) {
          if (keybindings.matches(data, "tui.select.confirm")) {
            done("approve");
          } else if (data === "d" || data === "D") {
            done("discuss");
          } else if (keybindings.matches(data, "tui.select.cancel")) {
            done("cancel");
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );

  return result as PlanApprovalChoice | undefined;
}
