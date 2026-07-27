import {
  buildDocRef,
  extractVersionInfo,
  getDocCacheByRef,
  normalizeText,
  putDocCache,
} from "./cache.ts";
import { fetchLibraryDocs } from "./client.ts";
import { loadSettings } from "./config.ts";
import { curateDocText } from "./curation.ts";
import {
  displayTitle,
  formatResolveResults,
  resolveLibraries,
  summarizeError,
} from "./resolution.ts";
import type { DocCacheIndexEntry, GetLibraryDocsParams, SearchResult } from "./types.ts";

function buildEffectiveQuery(query?: string, topic?: string, page?: number): string {
  const parts = [query?.trim(), topic?.trim() ? `Focus: ${topic.trim()}` : undefined];
  if (typeof page === "number" && page > 1) parts.push(`Requested page: ${page}`);
  return parts.filter(Boolean).join("\n\n") || "overview";
}

export function formatCacheCandidates(candidates: DocCacheIndexEntry[]): string {
  return candidates
    .slice(0, 8)
    .map((candidate) => {
      const parts = [
        `- docRef: ${candidate.docRef}`,
        `  Library: ${candidate.libraryName}`,
        `  Library ID: ${candidate.libraryId}`,
        candidate.libraryVersion ? `  Version: ${candidate.libraryVersion}` : undefined,
        candidate.topic ? `  Topic: ${candidate.topic}` : undefined,
        `  Query: ${candidate.query}`,
        `  Page: ${candidate.page}`,
        `  Cached At: ${candidate.createdAt}`,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n----------\n");
}

function normalizedLibraryNameFromResult(result?: SearchResult, fallback?: string): string {
  return normalizeText(result?.title || fallback || "unknown-library");
}

export async function getDocsEntry(params: GetLibraryDocsParams) {
  const settings = await loadSettings();
  const page =
    typeof params.page === "number" && Number.isFinite(params.page)
      ? Math.max(1, Math.floor(params.page))
      : 1;
  const effectiveQuery = buildEffectiveQuery(params.query, params.topic, page);

  let libraryId = params.libraryId?.trim();
  let libraryName = params.libraryName?.trim();
  let resolvedResult: SearchResult | undefined;
  let resolveMetadata: Record<string, unknown> | undefined;

  if (!libraryId) {
    if (!libraryName) {
      throw new Error("context7_get_library_docs requires either libraryId or libraryName.");
    }

    const resolveResult = await resolveLibraries({ libraryName, query: params.query });
    const formatted = formatResolveResults(resolveResult.response, libraryName);
    resolveMetadata = {
      source: resolveResult.source,
      staleBecause: resolveResult.staleBecause,
      configError: resolveResult.configError,
    };

    if (!formatted.recommended || formatted.ambiguous) {
      return {
        ok: false as const,
        text: `${formatted.text}\n\nUnable to safely auto-resolve before fetching docs. Call context7_resolve_library_id first or pass an exact libraryId.`,
        details: {
          needsResolution: true,
          candidates: resolveResult.response.results.slice(0, 8),
          resolve: resolveMetadata,
        },
      };
    }

    libraryId = formatted.recommended.id;
    resolvedResult = formatted.recommended;
    libraryName = displayTitle(formatted.recommended);
  }

  const docRef = buildDocRef(libraryId, effectiveQuery, page);
  const cached = await getDocCacheByRef(settings, docRef);
  if (cached.entry && cached.fresh) {
    return {
      ok: true as const,
      entry: cached.entry,
      source: "fresh-cache" as const,
      details: {
        docRef,
        cacheStatus: "fresh",
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    };
  }

  const network = await fetchLibraryDocs(settings, { libraryId, query: effectiveQuery });
  if (network.ok) {
    const version = extractVersionInfo(libraryId);
    const curated = curateDocText({
      rawText: network.data,
      libraryId,
      libraryName: libraryName || displayTitle(resolvedResult) || libraryId,
      libraryVersion: version.normalized,
      query: params.query,
      topic: params.topic,
      page,
      docRef,
    });

    const entry = await putDocCache(settings, {
      docRef,
      libraryId,
      libraryName: libraryName || displayTitle(resolvedResult) || libraryId,
      normalizedLibraryName: normalizedLibraryNameFromResult(resolvedResult, libraryName),
      libraryVersion: version.normalized,
      libraryVersionRaw: version.raw,
      query: params.query?.trim() || "overview",
      topic: params.topic?.trim(),
      effectiveQuery,
      page,
      rawText: network.data,
      curatedText: curated.text,
    });

    return {
      ok: true as const,
      entry,
      source: "network" as const,
      details: {
        docRef,
        cacheStatus: "refreshed",
        resolve: resolveMetadata,
        curation: {
          truncated: curated.truncated,
          selectedSectionCount: curated.selectedSectionCount,
          rawLength: curated.rawLength,
        },
        configError: settings.configError,
      },
    };
  }

  if (cached.entry) {
    return {
      ok: true as const,
      entry: cached.entry,
      source: "stale-cache" as const,
      details: {
        docRef,
        cacheStatus: "stale",
        staleBecause: network.error,
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    };
  }

  throw Object.assign(
    new Error(
      summarizeError(
        network.error,
        settings.configError ? `Config parse issue: ${settings.configError}` : undefined,
      ),
    ),
    {
      details: {
        upstreamError: network.error,
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    },
  );
}
