import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "pi";
import type { GrepAppSearchDetails, GrepAppSearchParams } from "./types.ts";

const EXPANDED_PREVIEW_RESULT_LIMIT = 5;

function wrapMultilineText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
    } else {
      lines.push(...wrapTextWithAnsi(paragraph, width));
    }
  }
  return lines;
}

export function renderGrepAppResult(
  result: AgentToolResult<GrepAppSearchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext<unknown, GrepAppSearchParams>,
) {
  const details = result.details;
  const args = context.args;
  const query = args.query ?? "unknown";
  const isError = context.isError || Boolean(details?.isError);

  if (isError) {
    const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
    return {
      render: (width: number) => [
        truncateToWidth(theme.fg("error", `✗ Grep: "${query}" — ${errorText}`), width),
      ],
      invalidate: () => {},
    };
  }

  if (options.isPartial) {
    return {
      render: (width: number) => [
        truncateToWidth(theme.fg("warning", `🔍 Grep: "${query}"...`), width),
      ],
      invalidate: () => {},
    };
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
        render: (width: number) => wrapMultilineText(text.trimEnd(), width),
        invalidate: () => {},
      };
    }
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return {
      render: (width: number) => wrapMultilineText(text, width),
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

  return {
    render: (width: number) => [
      truncateToWidth(theme.fg("success", `🔍 Grep: "${query}" — ${label}`), width),
    ],
    invalidate: () => {},
  };
}
