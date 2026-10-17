/**
 * Context7 Extension
 *
 * Pi-native Context7 documentation tools. Bypasses MCP entirely — direct HTTP to
 * Context7 API with persistent searchable cache.
 */

import type { ExtensionAPI } from "pi";
import { findDocCacheCandidates, getDocCacheByRef, loadDocCacheObject } from "./src/cache.ts";
import { loadSettings } from "./src/config.ts";
import { formatCacheCandidates, getDocsEntry } from "./src/docs.ts";
import { sliceRawDoc } from "./src/raw-output.ts";
import {
  createDocsRenderResult,
  createRawRenderResult,
  createResolveRenderResult,
} from "./src/renderers.ts";
import { formatResolveResults, resolveLibraries } from "./src/resolution.ts";
import {
  GET_CACHED_DOC_RAW_PARAMS,
  GET_LIBRARY_DOCS_PARAMS,
  RESOLVE_LIBRARY_PARAMS,
} from "./src/schemas.ts";
import type {
  CacheSearchSelector,
  GetLibraryDocsParams,
  ResolveLibraryParams,
} from "./src/types.ts";

export type { DocCacheIndexEntry } from "./src/types.ts";

// --- Extension ---

export default async function context7Extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7_resolve_library_id",
    label: "Context7 Resolve Library ID",
    description:
      "Resolve a library or package name to a Context7 library ID. Pi-native equivalent of Context7 MCP resolve-library-id.",
    promptSnippet:
      "List the Context7 library IDs that match a library or package name, to disambiguate or choose a specific ID.",
    promptGuidelines: [
      "context7_get_library_docs resolves library names itself. Use context7_resolve_library_id only when a name is ambiguous, a lookup returned the wrong library, or you need to pick a specific ID or version.",
    ],
    parameters: RESOLVE_LIBRARY_PARAMS,
    renderResult: createResolveRenderResult(),
    async execute(_toolCallId, params) {
      const resolved = await resolveLibraries(params as ResolveLibraryParams);
      const formatted = formatResolveResults(resolved.response, params.libraryName);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          source: resolved.source,
          staleBecause: resolved.staleBecause,
          configError: resolved.configError,
          recommendedLibraryId: formatted.recommended?.id,
          ambiguous: formatted.ambiguous,
          results: resolved.response.results,
        },
      };
    },
  });

  pi.registerTool({
    name: "context7_get_library_docs",
    label: "Context7 Get Library Docs",
    description:
      "Fetch curated, up-to-date Context7 docs by library ID or library name. Pi-native equivalent of Context7 MCP get-library-docs / query-docs.",
    promptSnippet:
      "Fetch curated, up-to-date Context7 docs for a library by ID or by name. Equivalent to Context7 MCP get-library-docs/query-docs.",
    promptGuidelines: [
      "Prefer context7_get_library_docs over raw cached docs retrieval; use it first for normal documentation lookup.",
      "If you only know the library name, pass libraryName to context7_get_library_docs and let it auto-resolve.",
    ],
    parameters: GET_LIBRARY_DOCS_PARAMS,
    renderResult: createDocsRenderResult(),
    async execute(_toolCallId, params) {
      const result = await getDocsEntry(params as GetLibraryDocsParams);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      }

      const entry = result.entry;
      const notes: string[] = [];
      if (result.source === "stale-cache")
        notes.push("Returned stale cached docs because the network refresh failed.");
      if (result.source === "fresh-cache") notes.push("Returned fresh cached docs.");
      if (result.source === "network")
        notes.push("Fetched docs from Context7 and refreshed the local cache.");

      return {
        content: [{ type: "text", text: `${entry.curatedText}\n\n${notes.join(" ")}`.trim() }],
        details: {
          ...result.details,
          docRef: entry.docRef,
          libraryId: entry.libraryId,
          libraryName: entry.libraryName,
          libraryVersion: entry.libraryVersion,
          page: entry.page,
          query: entry.query,
          topic: entry.topic,
          effectiveQuery: entry.effectiveQuery,
        },
      };
    },
  });

  pi.registerTool({
    name: "context7_get_cached_doc_raw",
    label: "Context7 Get Cached Raw Doc",
    description:
      "Read the raw cached Context7 document for a previous docs fetch. Prefer context7_get_library_docs first. Documents larger than 2,000 lines / 40,000 chars are returned as bounded windows; page with offsetLine (from nextOffsetLine in a truncated result).",
    promptSnippet:
      "Read the full raw cached Context7 document by docRef or semantic lookup when curated docs were insufficient; large docs page via offsetLine.",
    promptGuidelines: [
      "Use context7_get_cached_doc_raw only after context7_get_library_docs when you need the full cached raw documentation.",
      "When calling context7_get_cached_doc_raw, prefer docRef from an earlier tool result. If semantic lookup matches multiple cached docs, the tool will not guess.",
      "Documents over 2,000 lines / 40,000 chars arrive as a bounded window: keep calling with offsetLine = nextOffsetLine until truncated is false.",
    ],
    parameters: GET_CACHED_DOC_RAW_PARAMS,
    renderResult: createRawRenderResult(),
    async execute(_toolCallId, params) {
      const settings = await loadSettings();
      const selector: CacheSearchSelector = {
        docRef: params.docRef?.trim(),
        libraryId: params.libraryId?.trim(),
        libraryName: params.libraryName?.trim(),
        libraryVersion: params.libraryVersion?.trim(),
        query: params.query?.trim(),
        topic: params.topic?.trim(),
        page: typeof params.page === "number" ? Math.max(1, Math.floor(params.page)) : undefined,
      };

      if (selector.docRef) {
        const cached = await getDocCacheByRef(settings, selector.docRef);
        if (!cached.entry) {
          throw new Error(
            `No cached Context7 document found for docRef ${selector.docRef}. Call context7_get_library_docs first.`,
          );
        }
        const rawWindow = sliceRawDoc(cached.entry.rawText, params.offsetLine);
        return {
          content: [{ type: "text", text: rawWindow.text }],
          details: {
            docRef: cached.entry.docRef,
            libraryId: cached.entry.libraryId,
            libraryName: cached.entry.libraryName,
            libraryVersion: cached.entry.libraryVersion,
            cacheStatus: cached.fresh ? "fresh" : "stale",
            query: cached.entry.query,
            topic: cached.entry.topic,
            page: cached.entry.page,
            totalLines: rawWindow.totalLines,
            totalChars: rawWindow.totalChars,
            startLine: rawWindow.startLine,
            endLine: rawWindow.endLine,
            truncated: rawWindow.truncated,
            nextOffsetLine: rawWindow.nextOffsetLine,
          },
        };
      }

      if (
        !selector.libraryId &&
        !selector.libraryName &&
        !selector.libraryVersion &&
        !selector.query &&
        !selector.topic &&
        selector.page === undefined
      ) {
        throw new Error("context7_get_cached_doc_raw requires docRef or semantic lookup fields.");
      }

      const candidates = await findDocCacheCandidates(settings, selector);
      if (candidates.length === 0) {
        throw new Error(
          "No cached Context7 documents matched that lookup. Call context7_get_library_docs first.",
        );
      }

      if (candidates.length > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Multiple cached Context7 documents matched that lookup. Refine the lookup or use one of these docRefs:\n\n${formatCacheCandidates(candidates)}`,
            },
          ],
          details: {
            ambiguous: true,
            candidates,
          },
        };
      }

      const only = candidates[0];
      if (!only) {
        throw new Error(
          "Context7 cache returned a candidate set that was unexpectedly empty after filtering.",
        );
      }
      const entry = await loadDocCacheObject(settings, only);
      if (!entry) {
        throw new Error(
          `Cached Context7 document metadata exists for ${only.docRef}, but the object file is missing.`,
        );
      }

      const rawWindow = sliceRawDoc(entry.rawText, params.offsetLine);
      return {
        content: [{ type: "text", text: rawWindow.text }],
        details: {
          docRef: entry.docRef,
          libraryId: entry.libraryId,
          libraryName: entry.libraryName,
          libraryVersion: entry.libraryVersion,
          cacheStatus: new Date(entry.expiresAt).getTime() > Date.now() ? "fresh" : "stale",
          query: entry.query,
          topic: entry.topic,
          page: entry.page,
          totalLines: rawWindow.totalLines,
          totalChars: rawWindow.totalChars,
          startLine: rawWindow.startLine,
          endLine: rawWindow.endLine,
          truncated: rawWindow.truncated,
          nextOffsetLine: rawWindow.nextOffsetLine,
        },
      };
    },
  });
}
