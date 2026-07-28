import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "pi";
import { createToolStatus, wrapToolText } from "../../../lib/tool-renderer.ts";
import type { LspToolParams } from "./tool.ts";

interface LspResultDetails {
  /** diagnostics only: per-source diagnostic counts */
  groups?: Array<{ source: string; count: number }>;
  errors?: string[];
}

function resultText(result: AgentToolResult<LspResultDetails>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

export function renderLspResult(
  result: AgentToolResult<LspResultDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext<unknown, LspToolParams>,
) {
  const args = context.args;
  const operation = args.operation ?? "lsp";
  const target = args.filePath ?? args.query ?? "";

  if (context.isError) {
    return createToolStatus(theme, "error", `✗ lsp ${operation} — ${resultText(result)}`);
  }

  if (options.isPartial) {
    return createToolStatus(theme, "warning", `lsp ${operation} ${target}…`.trim());
  }

  if (options.expanded) {
    return {
      render: (width: number) => wrapToolText(resultText(result), width),
      invalidate: () => {},
    };
  }

  // Collapsed: summarize. Diagnostics expose counts; other ops just name the op + target.
  const groups = result.details?.groups;
  let label = target;
  if (operation === "diagnostics" && groups && groups.length > 0) {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    label = `${target} — ${total} ${total === 1 ? "diagnostic" : "diagnostics"}`.trim();
  }

  return createToolStatus(theme, "success", `lsp ${operation} ${label}`.trim());
}
