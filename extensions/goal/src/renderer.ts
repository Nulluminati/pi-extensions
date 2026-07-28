import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "pi";
import { createToolStatus, wrapToolText } from "../../../lib/tool-renderer.ts";

interface GoalCompleteDetails {
  status?: string;
  summary?: string;
  error?: string;
}

interface GoalCompleteParams {
  summary?: string;
}

function resultText(result: AgentToolResult<GoalCompleteDetails>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

export function renderGoalCompleteResult(
  result: AgentToolResult<GoalCompleteDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: ToolRenderContext<unknown, GoalCompleteParams>,
) {
  if (result.details?.error) {
    return createToolStatus(theme, "error", `✗ Goal — ${resultText(result)}`);
  }

  if (options.isPartial) {
    return createToolStatus(theme, "warning", "Goal: completing…");
  }

  if (options.expanded) {
    return {
      render: (width: number) => wrapToolText(resultText(result), width),
      invalidate: () => {},
    };
  }

  const summary = result.details?.summary;
  const label = summary ? `complete — ${summary}` : "complete";
  return createToolStatus(theme, "success", `✓ Goal ${label}`);
}
