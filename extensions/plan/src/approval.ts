/**
 * Plan approval modal: an overlay showing the proposed plan with key hints
 * for approving, editing, or keeping planning.
 */

import type { ExtensionUIContext } from "pi";
import { renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";
import { formatPlanText } from "./prompts.ts";
import type { Plan } from "./types.ts";

export type PlanApprovalChoice = "approve" | "edit" | "cancel";

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
    (_tui, theme, _keybindings, done) => {
      return {
        render(width: number) {
          const lines = [
            ...body,
            "",
            formatStyledKeyHints(theme, [
              ["enter", "approve & execute"],
              ["e", "edit plan"],
              ["esc", "keep planning"],
            ]),
          ];
          return renderModalFrame(theme, width, lines, { title: "Approve plan?" });
        },
        invalidate() {},
        handleInput(data: string) {
          if (data === "\r") {
            done("approve");
          } else if (data === "e" || data === "E") {
            done("edit");
          } else if (data === "\x1b") {
            done("cancel");
          }
        },
      };
    },
    { overlay: true },
  );

  return result as PlanApprovalChoice | undefined;
}
