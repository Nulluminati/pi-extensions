import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "pi";
import { buildSearchUrl, fetchGrepApp } from "./client.ts";
import { DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS, MIN_MAX_RESULTS } from "./constants.ts";
import { formatSearchResults } from "./results.ts";
import type { GrepAppSearchDetails, GrepAppSearchParams } from "./types.ts";

const MAX_QUERY_LENGTH = 1000;
const MAX_LANGUAGE_LENGTH = 50;
const MAX_REPO_LENGTH = 100;
const MAX_PATH_LENGTH = 200;

function validateRepoFormat(repo: string): boolean {
  return /^[^/]+\/[^/]+$/.test(repo.trim());
}

function clampMaxResults(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_MAX_RESULTS) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.floor(num));
}

// --- Tool parameter schemas ---

export const GREP_SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search query string. Supports plain text or regular expressions (grep.app uses RE2 syntax).",
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
};

export async function executeGrepAppSearch(
  _toolCallId: string,
  params: GrepAppSearchParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<GrepAppSearchDetails> | undefined,
  _ctx: ExtensionContext,
): Promise<AgentToolResult<GrepAppSearchDetails>> {
  const query = String(params.query ?? "").trim();
  if (!query) {
    return {
      content: [{ type: "text", text: "Error: query is required" }],
      details: {
        query: "",
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `Error: query is too long (max ${MAX_QUERY_LENGTH} characters).`,
        },
      ],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }

  const language = params.language?.trim();
  if (language && language.length > MAX_LANGUAGE_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `Error: language filter is too long (max ${MAX_LANGUAGE_LENGTH} characters).`,
        },
      ],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }

  const repo = params.repo?.trim();
  if (repo && !validateRepoFormat(repo)) {
    return {
      content: [
        {
          type: "text",
          text: "Error: repo filter must be in 'owner/repo' format (e.g., 'vercel/next.js').",
        },
      ],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }
  if (repo && repo.length > MAX_REPO_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `Error: repo filter is too long (max ${MAX_REPO_LENGTH} characters).`,
        },
      ],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }

  const path = params.path?.trim();
  if (path && path.length > MAX_PATH_LENGTH) {
    return {
      content: [
        {
          type: "text",
          text: `Error: path filter is too long (max ${MAX_PATH_LENGTH} characters).`,
        },
      ],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        isError: true,
      },
    };
  }

  const maxResults = clampMaxResults(params.max_results);
  const searchParams: GrepAppSearchParams = {
    query,
    ...(language && { language }),
    ...(repo && { repo }),
    ...(path && { path }),
    max_results: maxResults,
  };

  onUpdate?.({
    content: [{ type: "text", text: `Searching grep.app for: "${query}"...` }],
    details: {
      query,
      totalResults: 0,
      resultsShown: 0,
      repositoriesFound: 0,
      topLanguages: [],
      topRepositories: [],
      results: [],
      filters: { language, repo, path },
    },
  });

  try {
    const url = buildSearchUrl(searchParams);
    const data = await fetchGrepApp(url, signal);
    const { text, details } = formatSearchResults(query, data, maxResults);

    return {
      content: [{ type: "text", text }],
      details: {
        ...details,
        filters: { language, repo, path },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: {
        query,
        totalResults: 0,
        resultsShown: 0,
        repositoriesFound: 0,
        topLanguages: [],
        topRepositories: [],
        results: [],
        filters: { language, repo, path },
        isError: true,
      },
    };
  }
}
