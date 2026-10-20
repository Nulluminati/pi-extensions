import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../../../lib/pi-types.ts";
import { createToolStatus, wrapToolText as wrapMultilineText } from "../../../lib/tool-renderer.ts";
import type {
  CacheSearchSelector,
  GetLibraryDocsParams,
  ResolveLibraryParams,
  SearchResult,
} from "./types.ts";

export function createResolveRenderResult() {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<unknown, ResolveLibraryParams>,
  ) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args;
    const libraryName = args.libraryName ?? "unknown";

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return createToolStatus(theme, "error", `✗ Resolve: "${libraryName}" — ${errorText}`);
    }

    if (options.isPartial) {
      return createToolStatus(theme, "warning", `📚 Resolving: "${libraryName}"...`);
    }

    if (options.expanded) {
      const results = details?.results as SearchResult[] | undefined;
      if (results && results.length > 0) {
        const limit = 5;
        const visible = results.slice(0, limit);
        let text = "";
        for (const r of visible) {
          const metaParts: string[] = [];
          if (typeof r.totalSnippets === "number" && r.totalSnippets > 0)
            metaParts.push(`${r.totalSnippets} snippets`);
          if (typeof r.benchmarkScore === "number" && r.benchmarkScore > 0)
            metaParts.push(`score ${r.benchmarkScore}`);
          const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
          text += `${theme.fg("dim", `• ${r.title || "Untitled"} — ${r.id}${meta}`)}\n`;
        }
        if (results.length > limit) {
          text += theme.fg("muted", `... and ${results.length - limit} more`);
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

    const ambiguous = Boolean(details?.ambiguous);
    const recommended = String(details?.recommendedLibraryId ?? "");
    const resultCount = Array.isArray(details?.results)
      ? (details.results as SearchResult[]).length
      : 0;

    let label: string;
    if (ambiguous) {
      label = `ambiguous (${resultCount} candidates)`;
    } else if (recommended) {
      label = `→ ${recommended}`;
    } else if (resultCount === 0) {
      label = "no matches";
    } else {
      label = `${resultCount} candidate${resultCount !== 1 ? "s" : ""}`;
    }

    const source = String(details?.source ?? "");
    const cacheNote =
      source === "fresh-cache" ? " (cached)" : source === "stale-cache" ? " (stale)" : "";

    return createToolStatus(theme, "success", `📚 Resolve: "${libraryName}" ${label}${cacheNote}`);
  };
}

export function createDocsRenderResult() {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<unknown, GetLibraryDocsParams>,
  ) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args;
    const displayName = args.libraryName || args.libraryId || "unknown";

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return createToolStatus(theme, "error", `✗ Docs: ${displayName} — ${errorText}`);
    }

    if (options.isPartial) {
      return createToolStatus(theme, "warning", `📖 Fetching docs: ${displayName}...`);
    }

    if (options.expanded) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = text.split("\n");
      const limit = 10;
      const visible = lines.slice(0, limit);
      let preview = "";
      for (const line of visible) {
        preview += `${theme.fg("dim", line)}\n`;
      }
      if (lines.length > limit) {
        preview += theme.fg("muted", `... and ${lines.length - limit} more lines`);
      }
      return {
        render: (width: number) => wrapMultilineText(preview.trimEnd(), width),
        invalidate: () => {},
      };
    }

    const needsResolution = Boolean(details?.needsResolution);
    const cacheStatus = String(details?.cacheStatus ?? "");
    const query = String(args.query ?? "");
    const cacheNote =
      cacheStatus === "fresh"
        ? " (cached)"
        : cacheStatus === "stale"
          ? " (stale)"
          : cacheStatus === "refreshed"
            ? " (refreshed)"
            : "";
    const queryPart = query ? ` — ${query.slice(0, 30)}${query.length > 30 ? "..." : ""}` : "";

    if (needsResolution) {
      return createToolStatus(
        theme,
        "warning",
        `📖 Docs: ${displayName}${queryPart} — needs resolution`,
      );
    }

    return createToolStatus(theme, "success", `📖 Docs: ${displayName}${queryPart}${cacheNote}`);
  };
}

export function createRawRenderResult() {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<unknown, CacheSearchSelector>,
  ) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args;
    const docRef = String(args.docRef ?? details?.docRef ?? "unknown");

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return createToolStatus(theme, "error", `✗ Raw: ${docRef} — ${errorText}`);
    }

    if (options.isPartial) {
      return createToolStatus(theme, "warning", `📄 Loading raw docs...`);
    }

    if (options.expanded) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = text.split("\n");
      const limit = 10;
      const visible = lines.slice(0, limit);
      let preview = "";
      for (const line of visible) {
        preview += `${theme.fg("dim", line)}\n`;
      }
      if (lines.length > limit) {
        preview += theme.fg("muted", `... and ${lines.length - limit} more lines`);
      }
      return {
        render: (width: number) => wrapMultilineText(preview.trimEnd(), width),
        invalidate: () => {},
      };
    }

    const ambiguous = Boolean(details?.ambiguous);
    const candidateCount = Array.isArray(details?.candidates)
      ? (details.candidates as unknown[]).length
      : 0;
    const cacheStatus = String(details?.cacheStatus ?? "");
    const cacheNote =
      cacheStatus === "fresh" ? " (fresh)" : cacheStatus === "stale" ? " (stale)" : "";
    const libraryName = String(details?.libraryName ?? args.libraryName ?? "unknown");
    const startLine = Number(details?.startLine ?? 1);
    const totalLines = Number(details?.totalLines ?? 0);
    const endLine = Number(details?.endLine ?? 0);
    const rangeNote =
      totalLines > 0 && (startLine > 1 || Boolean(details?.truncated))
        ? ` — lines ${startLine}-${endLine} of ${totalLines}`
        : "";

    if (ambiguous) {
      return createToolStatus(
        theme,
        "warning",
        `📄 Raw: ${libraryName} — ambiguous (${candidateCount})`,
      );
    }

    return createToolStatus(
      theme,
      "success",
      `📄 Raw: ${libraryName} — ${docRef.slice(0, 40)}${docRef.length > 40 ? "..." : ""}${cacheNote}${rangeNote}`,
    );
  };
}
