/**
 * Plan approval prompt: the proposed plan with key hints for approving or
 * keeping planning. Renders in the editor slot (not an overlay), matching
 * pi's other blocking prompts.
 */

import type { ExtensionUIContext } from "pi";
import { type ModalFrameOptions, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { formatPlanText } from "./prompts.ts";
import type { Plan } from "./types.ts";

export type PlanApprovalChoice = "approve" | "cancel";

/**
 * Shows the plan in a framed prompt. A long plan clips with a "↓ N more
 * lines" indicator instead of blowing past the terminal height. Resolves with
 * the user's choice, or undefined when the dialog cannot run (for example
 * RPC mode).
 */
export async function promptPlanApproval(
  ui: ExtensionUIContext,
  plan: Plan,
): Promise<PlanApprovalChoice | undefined> {
  const body = formatPlanText(plan).split("\n");
  const result = await ui.custom<PlanApprovalChoice>((tui, theme, keybindings, done) => {
    return {
      render(width: number) {
        const rows = tui?.terminal?.rows ?? 0;
        const options: ModalFrameOptions = { title: "Approve plan?" };
        if (rows > 0) {
          // Plan body plus blank line plus the hints line, capped to the
          // terminal height minus frame borders and padding so the hints stay
          // visible.
          options.fixedBodyRows = Math.max(6, rows - 6);
        }
        const lines = [
          ...body,
          "",
          formatStyledKeyHints(theme, [
            ["enter", "approve & execute"],
            ["esc", "keep planning"],
          ]),
        ];
        return renderModalFrame(theme, width, lines, options);
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
