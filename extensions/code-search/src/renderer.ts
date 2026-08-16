import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "pi";
import { createToolStatus, wrapToolText } from "../../../lib/tool-renderer.ts";
import type { CodeSearchDetails, CodeSearchParams } from "./types.ts";

const EXPANDED_PREVIEW_RESULT_LIMIT = 5;

export function renderCodeSearchResult(
  result: AgentToolResult<CodeSearchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext<unknown, CodeSearchParams>,
) {
  const details = result.details;
  const args = context.args;
  const query = args.query ?? "unknown";
  const isError = context.isError || Boolean(details?.isError);

  if (isError) {
    const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
    return createToolStatus(theme, "error", `✗ Code search: "${query}" — ${errorText}`);
  }

  if (options.isPartial) {
    return createToolStatus(theme, "warning", `🔍 Code search: "${query}"...`);
  }

  if (options.expanded) {
    const results = details?.results ?? [];
    if (results.length > 0) {
      const limit = EXPANDED_PREVIEW_RESULT_LIMIT;
      const visible = results.slice(0, limit);
      let text = "";
      for (const repo of visible) {
        text += `${theme.fg("dim", `• ${repo.repository} — ${repo.files.length} file${repo.files.length !== 1 ? "s" : ""}`)}\n`;
      }
      if (results.length > limit) {
        text += theme.fg("muted", `... and ${results.length - limit} more repositories`);
      }
      return {
        render: (width: number) => wrapToolText(text.trimEnd(), width),
        invalidate: () => {},
      };
    }
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return {
      render: (width: number) => wrapToolText(text, width),
      invalidate: () => {},
    };
  }

  const totalResults = details?.totalResults ?? 0;
  const resultsShown = details?.resultsShown ?? 0;
  const repositoriesFound = details?.repositoriesFound ?? 0;
  const label =
    totalResults === 0
      ? "no results"
      : `${totalResults.toLocaleString()} match${totalResults !== 1 ? "es" : ""} in ${repositoriesFound} repo${repositoriesFound !== 1 ? "s" : ""} (${resultsShown} shown)`;

  return createToolStatus(theme, "success", `🔍 Code search: "${query}" — ${label}`);
}
