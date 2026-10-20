import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { createToolStatus, wrapToolText } from "../../../lib/tool-renderer.ts";
import { FETCH_PREVIEW_LINE_LIMIT, SEARCH_PREVIEW_RESULT_LIMIT } from "./constants.ts";
import type { SearchResult } from "./types.ts";

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }
  return results.map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`).join("\n\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function renderSearchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details as Record<string, unknown> | undefined;
  const query = String(details?.query ?? "");
  const count = Number(details?.resultCount ?? 0);
  const isError = Boolean(details?.isError);
  const errorText = isError
    ? result.content[0]?.type === "text"
      ? result.content[0].text
      : ""
    : "";
  if (isError) {
    return createToolStatus(theme, "error", `✗ Search: "${query}" — ${errorText}`);
  }
  if (options.isPartial) {
    return createToolStatus(theme, "warning", `🔍 Searching: "${query}"...`);
  }
  if (options.expanded) {
    const results = details?.results as SearchResult[] | undefined;
    if (results && results.length > 0) {
      const limit = SEARCH_PREVIEW_RESULT_LIMIT;
      const visible = results.slice(0, limit);
      let text = "";
      for (const r of visible) {
        text += `${theme.fg("dim", `• ${r.title}`)}\n`;
      }
      if (results.length > limit) {
        text += theme.fg("muted", `... and ${results.length - limit} more results`);
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
  const label = count === 0 ? "no results" : `${count} result${count !== 1 ? "s" : ""}`;
  return createToolStatus(theme, "success", `🔍 Search: "${query}" — ${label}`);
}

export function renderFetchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  const details = result.details as Record<string, unknown> | undefined;
  const url = String(details?.url ?? "");
  const isError = Boolean(details?.isError);
  const errorText = isError
    ? result.content[0]?.type === "text"
      ? result.content[0].text
      : ""
    : "";
  if (isError) {
    return createToolStatus(theme, "error", `✗ Fetch: ${url} — ${errorText}`);
  }
  if (options.isPartial) {
    return createToolStatus(theme, "warning", `📄 Fetching: ${url}...`);
  }
  if (options.expanded) {
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const fullOutputPath = details?.fullOutputPath as string | undefined;
    const lines = text.split("\n");
    const visible = lines.slice(0, FETCH_PREVIEW_LINE_LIMIT);
    let preview = "";
    for (const line of visible) {
      preview += `${theme.fg("dim", line)}\n`;
    }
    if (lines.length > FETCH_PREVIEW_LINE_LIMIT) {
      const remaining = lines.length - FETCH_PREVIEW_LINE_LIMIT;
      let ellipsis = `... and ${remaining} more line${remaining !== 1 ? "s" : ""}`;
      if (fullOutputPath) {
        ellipsis += ` — full content at ${fullOutputPath}`;
      }
      preview += theme.fg("muted", ellipsis);
    }
    return {
      render: (width: number) => wrapToolText(preview.trimEnd(), width),
      invalidate: () => {},
    };
  }
  const title = details?.title ? ` — ${details.title}` : "";
  const contentLength = details?.contentLength as number | undefined;
  const size = contentLength != null ? ` (${formatBytes(contentLength)})` : "";
  return createToolStatus(theme, "success", `📄 Fetch: ${url}${title}${size}`);
}
