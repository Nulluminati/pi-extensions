import { getResolveCache, normalizeText, putResolveCache } from "./cache.ts";
import { searchLibraries } from "./client.ts";
import { loadSettings } from "./config.ts";
import type { ResolveLibraryParams, SearchResponse, SearchResult } from "./types.ts";

// --- Tool logic helpers ---

export function displayTitle(result?: SearchResult): string {
  if (!result) return "";
  return result.title || result.id;
}

function snippetCount(result: SearchResult): number {
  return typeof result.totalSnippets === "number" && result.totalSnippets > 0
    ? result.totalSnippets
    : 0;
}

function benchmarkScore(result: SearchResult): number {
  return typeof result.benchmarkScore === "number" ? result.benchmarkScore : 0;
}

function trustScore(result: SearchResult): number {
  return typeof result.trustScore === "number" ? result.trustScore : 0;
}

function selectBestLibrary(
  results: SearchResult[],
  libraryName: string,
): { selected?: SearchResult; ambiguous: boolean } {
  if (results.length === 0) return { ambiguous: false };
  if (results.length === 1) {
    const only = results[0];
    if (!only) return { ambiguous: false };
    return { selected: only, ambiguous: false };
  }

  const target = normalizeText(libraryName).replace(/^@/, "");
  const scored = results
    .map((result) => {
      const title = normalizeText(result.title);
      const id = normalizeText(result.id);
      let score =
        benchmarkScore(result) / 10 + trustScore(result) + Math.min(snippetCount(result), 100) / 20;
      if (title === target) score += 25;
      if (title.includes(target)) score += 12;
      if (id.endsWith(`/${target}`) || id.includes(`/${target}/`)) score += 12;
      return { result, score };
    })
    .sort((a, b) => b.score - a.score);

  const [top, second] = scored;
  if (!top) return { ambiguous: true };
  if (!second) return { selected: top.result, ambiguous: false };

  const clearByExactMatch =
    normalizeText(top.result.title) === target ||
    normalizeText(top.result.id).endsWith(`/${target}`) ||
    top.score >= second.score + 8;

  if (clearByExactMatch) return { selected: top.result, ambiguous: false };
  return { ambiguous: true };
}

function formatResolveCandidate(result: SearchResult): string {
  const parts = [
    `- Title: ${displayTitle(result)}`,
    `  Library ID: ${result.id}`,
    `  Description: ${result.description}`,
  ];

  if (snippetCount(result) > 0) parts.push(`  Code Snippets: ${snippetCount(result)}`);
  if (trustScore(result) > 0) parts.push(`  Source Reputation Score: ${trustScore(result)}`);
  if (benchmarkScore(result) > 0) parts.push(`  Benchmark Score: ${benchmarkScore(result)}`);
  if (result.versions?.length) parts.push(`  Versions: ${result.versions.join(", ")}`);
  if (result.source) parts.push(`  Source: ${result.source}`);

  return parts.join("\n");
}

export function formatResolveResults(
  response: SearchResponse,
  libraryName: string,
): { text: string; recommended?: SearchResult; ambiguous: boolean } {
  if (!response.results.length) {
    return {
      text: `No Context7 libraries matched "${libraryName}".`,
      ambiguous: false,
    };
  }

  const recommendation = selectBestLibrary(response.results, libraryName);
  const header = [
    `Context7 matches for "${libraryName}":`,
    recommendation.selected ? `Recommended library ID: ${recommendation.selected.id}` : undefined,
    recommendation.ambiguous
      ? "Auto-resolution is ambiguous; choose one of the candidates below."
      : undefined,
    "",
  ].filter(Boolean) as string[];

  const body = response.results.slice(0, 8).map(formatResolveCandidate).join("\n----------\n");
  return {
    text: `${header.join("\n")}\n${body}`,
    ...(recommendation.selected ? { recommended: recommendation.selected } : {}),
    ambiguous: recommendation.ambiguous,
  };
}

export function summarizeError(
  error: { message: string; upstreamMessage?: string | undefined },
  extra?: string,
): string {
  return [error.message, extra].filter(Boolean).join(" ");
}

export async function resolveLibraries(params: ResolveLibraryParams) {
  const settings = await loadSettings();
  const query = params.query?.trim() || params.libraryName.trim();
  const cached = await getResolveCache(settings, params.libraryName, query);

  if (cached.entry && cached.fresh) {
    return {
      source: "fresh-cache" as const,
      response: { results: cached.entry.results },
      configError: settings.configError,
    };
  }

  const network = await searchLibraries(settings, { libraryName: params.libraryName, query });
  if (network.ok) {
    const entry = await putResolveCache(settings, {
      libraryName: params.libraryName,
      query,
      results: network.data.results,
    });
    return {
      source: "network" as const,
      response: { results: entry.results, searchFilterApplied: network.data.searchFilterApplied },
      configError: settings.configError,
    };
  }

  if (cached.entry) {
    return {
      source: "stale-cache" as const,
      response: { results: cached.entry.results },
      configError: settings.configError,
      staleBecause: network.error,
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
      details: { upstreamError: network.error, configError: settings.configError },
    },
  );
}
