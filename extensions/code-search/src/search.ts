import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { asStructuredContent } from "../../../lib/structured-content.ts";
import { buildSearchUrl, fetchSourcegraphSearch } from "./client.ts";
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  MIN_MAX_RESULTS,
} from "./constants.ts";
import { formatSearchResults } from "./results.ts";
import type { CodeSearchDetails, CodeSearchParams } from "./types.ts";

const MAX_QUERY_LENGTH = 1000;
const MAX_LANGUAGE_LENGTH = 50;
const MAX_REPO_LENGTH = 100;
const MAX_PATH_LENGTH = 200;

// --- Tool parameter schema ---

export const CODE_SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search query. Terms are ANDed; quote exact strings (e.g. 'useEffect cleanup'). Parentheses only work within a single term.",
    },
    language: {
      type: "string",
      description: "Optional programming language filter (e.g., 'Python', 'JavaScript', 'Go').",
    },
    repo: {
      type: "string",
      description: "Optional repository filter in 'owner/repo' format (e.g., 'vercel/next.js').",
    },
    path: {
      type: "string",
      description: "Optional path filter for specific directories (e.g., 'src/').",
    },
    max_results: {
      type: "number",
      description: `Maximum number of result files to return (${MIN_MAX_RESULTS}-${MAX_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
    },
  },
  required: ["query"],
} as const;

const FACET_OUTPUT = {
  type: "array",
  items: {
    type: "object",
    properties: { val: { type: "string" }, count: { type: "number" } },
    required: ["val", "count"],
  },
};

export const CODE_SEARCH_OUTPUT = {
  type: "object",
  properties: {
    query: { type: "string" },
    totalResults: { type: "number" },
    resultsShown: { type: "number" },
    repositoriesFound: { type: "number" },
    topLanguages: FACET_OUTPUT,
    topRepositories: FACET_OUTPUT,
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          repository: { type: "string" },
          matchesCount: { type: "number" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                branch: { type: "string" },
                totalMatches: { type: "number" },
                lineNumbers: { type: "array", items: { type: "number" } },
                language: { type: "string" },
                codeSnippet: { type: "string" },
              },
              required: [
                "filePath",
                "branch",
                "totalMatches",
                "lineNumbers",
                "language",
                "codeSnippet",
              ],
            },
          },
        },
        required: ["repository", "matchesCount", "files"],
      },
    },
    filters: {
      type: "object",
      properties: {
        language: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
      },
    },
    isError: { type: "boolean" },
    error: { type: "string" },
  },
  required: [
    "query",
    "totalResults",
    "resultsShown",
    "repositoriesFound",
    "topLanguages",
    "topRepositories",
    "results",
  ],
};

// --- Result cache ---

export interface CodeSearchCacheEntry {
  result: AgentToolResult<CodeSearchDetails>;
  expiresAt: number;
}

export type CodeSearchCache = Map<string, CodeSearchCacheEntry>;

export function createCodeSearchCache(): CodeSearchCache {
  return new Map();
}

function cacheKey(params: CodeSearchParams): string {
  return JSON.stringify([
    params.query,
    params.language ?? null,
    params.repo ?? null,
    params.path ?? null,
    params.max_results ?? null,
  ]);
}

function readCache(cache: CodeSearchCache, key: string): AgentToolResult<CodeSearchDetails> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function writeCache(
  cache: CodeSearchCache,
  key: string,
  result: AgentToolResult<CodeSearchDetails>,
) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Validation helpers ---

function validateRepoFormat(repo: string): boolean {
  return /^[^/]+\/[^/]+$/.test(repo.trim());
}

function clampMaxResults(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_MAX_RESULTS) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.floor(num));
}

/**
 * Sourcegraph's public API silently returns zero matches for several
 * query shapes containing parentheses: multi-term queries where any term has
 * parens (order- and time-dependent), and quoted phrases with parens (a
 * phrase literally present in an indexed file can match nothing). Parens are
 * only reliable inside a single unquoted term, so reject everything else up
 * front with guidance instead of letting the model trust a false negative.
 */
function hasUnreliableParens(query: string): boolean {
  if (!/[()]/.test(query)) return false;
  if (/\s/.test(query)) return true;
  if (query.startsWith('"') && query.endsWith('"') && query.length >= 2) return true;
  return false;
}

function errorResult(
  query: string,
  text: string,
  filters?: CodeSearchDetails["filters"],
): AgentToolResult<CodeSearchDetails> {
  const details: CodeSearchDetails = {
    query,
    totalResults: 0,
    resultsShown: 0,
    repositoriesFound: 0,
    topLanguages: [],
    topRepositories: [],
    results: [],
    ...(filters && { filters }),
    isError: true,
  };
  return {
    content: [{ type: "text", text }],
    isError: true,
    details,
    structuredContent: asStructuredContent({ ...details, error: text }),
  };
}

// --- Tool execution ---

export async function executeCodeSearch(
  _toolCallId: string,
  params: CodeSearchParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<CodeSearchDetails> | undefined,
  _ctx: ExtensionContext,
  cache: CodeSearchCache,
): Promise<AgentToolResult<CodeSearchDetails>> {
  const query = String(params.query ?? "").trim();
  const language = params.language?.trim();
  const repo = params.repo?.trim();
  const path = params.path?.trim();

  if (!query) {
    return errorResult("", "Error: query is required");
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return errorResult(query, `Error: query is too long (max ${MAX_QUERY_LENGTH} characters).`);
  }
  if (hasUnreliableParens(query)) {
    return errorResult(
      query,
      "Error: parentheses are only reliable in a single unquoted term on this API; other shapes return false zeros. Use a single term like MarshalJSON(), or remove the parentheses.",
    );
  }
  if (language && language.length > MAX_LANGUAGE_LENGTH) {
    return errorResult(
      query,
      `Error: language filter is too long (max ${MAX_LANGUAGE_LENGTH} characters).`,
    );
  }
  if (repo && !validateRepoFormat(repo)) {
    return errorResult(
      query,
      "Error: repo filter must be in 'owner/repo' format (e.g., 'vercel/next.js').",
    );
  }
  if (repo && repo.length > MAX_REPO_LENGTH) {
    return errorResult(
      query,
      `Error: repo filter is too long (max ${MAX_REPO_LENGTH} characters).`,
    );
  }
  if (path && path.length > MAX_PATH_LENGTH) {
    return errorResult(
      query,
      `Error: path filter is too long (max ${MAX_PATH_LENGTH} characters).`,
    );
  }

  const filters: CodeSearchDetails["filters"] = {
    ...(language ? { language } : {}),
    ...(repo ? { repo } : {}),
    ...(path ? { path } : {}),
  };
  const searchParams: CodeSearchParams = {
    query,
    ...(language && { language }),
    ...(repo && { repo }),
    ...(path && { path }),
    max_results: clampMaxResults(params.max_results),
  };

  const key = cacheKey(searchParams);
  const cached = readCache(cache, key);
  if (cached) {
    return cached;
  }

  onUpdate?.({
    content: [{ type: "text", text: `Searching Sourcegraph for: "${query}"...` }],
    details: {
      query,
      totalResults: 0,
      resultsShown: 0,
      repositoriesFound: 0,
      topLanguages: [],
      topRepositories: [],
      results: [],
      filters,
    },
  });

  try {
    const url = buildSearchUrl(searchParams);
    const streamData = await fetchSourcegraphSearch(url, signal);
    const { text, details } = formatSearchResults(
      query,
      streamData,
      searchParams.max_results ?? DEFAULT_MAX_RESULTS,
    );

    const result: AgentToolResult<CodeSearchDetails> = {
      content: [{ type: "text", text }],
      details: { ...details, filters },
      structuredContent: asStructuredContent({ ...details, filters }),
    };
    writeCache(cache, key, result);
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      return errorResult(query, "Error: search timed out or was cancelled.", filters);
    }
    return errorResult(query, `Error: ${message}`, filters);
  }
}
