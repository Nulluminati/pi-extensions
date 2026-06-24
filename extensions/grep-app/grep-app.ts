/**
 * Grep.app Extension
 *
 * Pi-native code search across public GitHub repositories using the grep.app API.
 * Bypasses MCP entirely — direct HTTP with no API key required.
 */

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "pi";

// --- Constants ---

const GREP_APP_API_URL = "https://grep.app/api/search";
const DEFAULT_MAX_RESULTS = 10;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 50;
const MAX_QUERY_LENGTH = 1000;
const MAX_LANGUAGE_LENGTH = 50;
const MAX_REPO_LENGTH = 100;
const MAX_PATH_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SNIPPET_LENGTH = 400;
const MAX_SNIPPET_LINES = 8;
const EXPANDED_PREVIEW_RESULT_LIMIT = 5;

const USER_AGENT = "Mozilla/5.0 (compatible; pi-grep-app/1.0)";

const HTML_TAG_REGEX = /<[^>]+>/g;
const DATA_LINE_REGEX = /data-line="(\d+)"/g;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  java: "java",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  go: "go",
  rs: "rust",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  md: "markdown",
  markdown: "markdown",
  tex: "latex",
  r: "r",
  pl: "perl",
  lua: "lua",
  vim: "vim",
  dockerfile: "dockerfile",
  makefile: "makefile",
  make: "makefile",
};

// --- Types ---

interface GrepAppFacetBucket {
  val: string;
  count: number;
}

interface GrepAppFacets {
  count?: number;
  lang?: { buckets?: GrepAppFacetBucket[] };
  repo?: { buckets?: GrepAppFacetBucket[] };
}

interface GrepAppHit {
  repo?: { raw?: string };
  path?: { raw?: string };
  branch?: { raw?: string };
  total_matches?: { raw?: string };
  content?: { snippet?: string };
}

interface GrepAppRawResponse {
  facets?: GrepAppFacets;
  hits?: { hits?: GrepAppHit[] };
}

interface GrepAppFileResult {
  filePath: string;
  branch: string;
  totalMatches: number;
  lineNumbers: number[];
  language: string;
  codeSnippet: string;
}

interface GrepAppRepoResult {
  repository: string;
  matchesCount: number;
  files: GrepAppFileResult[];
}

interface GrepAppSearchParams {
  query: string;
  language?: string;
  repo?: string;
  path?: string;
  max_results?: number;
}

interface GrepAppSearchDetails {
  query: string;
  totalResults: number;
  resultsShown: number;
  repositoriesFound: number;
  topLanguages: GrepAppFacetBucket[];
  topRepositories: GrepAppFacetBucket[];
  results: GrepAppRepoResult[];
  filters?: {
    language?: string;
    repo?: string;
    path?: string;
  };
  isError?: boolean;
}

// --- Pure utility functions ---

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanHtmlSnippet(html: string): string {
  const text = html.replace(HTML_TAG_REGEX, "");
  return decodeHtmlEntities(text).trim();
}

function extractLineNumbers(html: string): number[] {
  const numbers: number[] = [];
  const matches = html.matchAll(DATA_LINE_REGEX);
  for (const match of matches) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

function languageFromPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[extension] ?? "text";
}

function formatCodeSnippet(snippet: string, language: string): string {
  const cleaned = snippet.trim();
  if (!cleaned) return "";

  let truncated = cleaned;
  if (cleaned.length > MAX_SNIPPET_LENGTH) {
    truncated = `${cleaned.slice(0, MAX_SNIPPET_LENGTH)}...`;
  }

  const lines = truncated.split("\n");
  if (lines.length > MAX_SNIPPET_LINES) {
    const visible = lines.slice(0, MAX_SNIPPET_LINES);
    return `${visible.join("\n")}\n... (truncated)`;
  }

  if (language && language !== "text") {
    return `\`\`\`${language}\n${truncated}\n\`\`\``;
  }
  return truncated;
}

function validateRepoFormat(repo: string): boolean {
  return /^[^/]+\/[^/]+$/.test(repo.trim());
}

function clampMaxResults(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < MIN_MAX_RESULTS) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_MAX_RESULTS, Math.floor(num));
}

function buildSearchUrl(params: GrepAppSearchParams): string {
  const url = new URL(GREP_APP_API_URL);
  url.searchParams.set("q", params.query);

  if (params.language) {
    url.searchParams.set("f.lang", params.language.trim());
  }
  if (params.repo) {
    url.searchParams.set("f.repo", params.repo.trim());
  }
  if (params.path) {
    url.searchParams.set("f.path", params.path.trim());
  }

  return url.toString();
}

function normalizeHit(hit: GrepAppHit): {
  repository: string;
  filePath: string;
  branch: string;
  totalMatches: number;
  lineNumbers: number[];
  language: string;
  codeSnippet: string;
} {
  const repository = hit.repo?.raw ?? "unknown";
  const filePath = hit.path?.raw ?? "unknown";
  const branch = hit.branch?.raw ?? "main";
  const totalMatchesRaw = hit.total_matches?.raw ?? "0";
  const totalMatches = /^\d+$/.test(totalMatchesRaw) ? Number(totalMatchesRaw) : 0;
  const htmlSnippet = hit.content?.snippet ?? "";
  const lineNumbers = extractLineNumbers(htmlSnippet);
  const cleanSnippet = cleanHtmlSnippet(htmlSnippet);
  const language = languageFromPath(filePath);

  return {
    repository,
    filePath,
    branch,
    totalMatches,
    lineNumbers,
    language,
    codeSnippet: formatCodeSnippet(cleanSnippet, language),
  };
}

function groupResultsByRepo(hits: GrepAppHit[]): GrepAppRepoResult[] {
  const repoMap = new Map<string, GrepAppRepoResult>();

  for (const hit of hits) {
    const normalized = normalizeHit(hit);
    let repoResult = repoMap.get(normalized.repository);
    if (!repoResult) {
      repoResult = { repository: normalized.repository, matchesCount: 0, files: [] };
      repoMap.set(normalized.repository, repoResult);
    }

    repoResult.files.push({
      filePath: normalized.filePath,
      branch: normalized.branch,
      totalMatches: normalized.totalMatches,
      lineNumbers: normalized.lineNumbers,
      language: normalized.language,
      codeSnippet: normalized.codeSnippet,
    });
    repoResult.matchesCount += normalized.totalMatches;
  }

  return Array.from(repoMap.values()).sort((a, b) => b.matchesCount - a.matchesCount);
}

function formatRepoResult(repo: GrepAppRepoResult): string {
  const header = `## ${repo.repository} (${repo.matchesCount} match${repo.matchesCount !== 1 ? "es" : ""})`;
  const files = repo.files
    .map((file) => {
      const lines = file.lineNumbers.length > 0 ? ` (lines ${file.lineNumbers.join(", ")})` : "";
      const parts = [`### ${file.filePath}${lines}`, `Branch: ${file.branch}`, file.codeSnippet];
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${files}`;
}

function formatBucketList(buckets: GrepAppFacetBucket[]): string {
  if (buckets.length === 0) return "None";
  return buckets.map((bucket) => `- ${bucket.val}: ${bucket.count}`).join("\n");
}

function formatSearchResults(
  query: string,
  data: GrepAppRawResponse,
  maxResults: number,
): { text: string; details: GrepAppSearchDetails } {
  const facets = data.facets ?? {};
  const totalResults = typeof facets.count === "number" ? facets.count : 0;
  const hits = data.hits?.hits ?? [];
  const limitedHits = hits.slice(0, maxResults);
  const repoResults = groupResultsByRepo(limitedHits);

  const topLanguages = (facets.lang?.buckets ?? []).slice(0, 5);
  const topRepositories = (facets.repo?.buckets ?? []).slice(0, 5);

  const details: GrepAppSearchDetails = {
    query,
    totalResults,
    resultsShown: repoResults.reduce((sum, repo) => sum + repo.files.length, 0),
    repositoriesFound: repoResults.length,
    topLanguages,
    topRepositories,
    results: repoResults,
  };

  if (repoResults.length === 0) {
    return {
      text: `No code results found for: ${query}`,
      details,
    };
  }

  const summaryLines = [
    `# Grep.app results for "${query}"`,
    `Total matches: ${totalResults.toLocaleString()}`,
    `Results shown: ${details.resultsShown}`,
    `Repositories found: ${details.repositoriesFound}`,
    "",
    "## Top languages",
    formatBucketList(topLanguages),
    "",
    "## Top repositories",
    formatBucketList(topRepositories),
    "",
    repoResults.map(formatRepoResult).join("\n\n----------\n\n"),
  ];

  return {
    text: summaryLines.join("\n"),
    details,
  };
}

async function fetchGrepApp(
  url: string,
  signal: AbortSignal | undefined,
): Promise<GrepAppRawResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  if (signal) {
    const onCallerAbort = () => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please wait before making another request.");
    }

    if (!response.ok) {
      throw new Error(`grep.app API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as GrepAppRawResponse;
    if (!data || typeof data !== "object") {
      throw new Error("grep.app returned an invalid response.");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

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

// --- Tool parameter schemas ---

const GREP_SEARCH_PARAMS = {
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

// --- Extension export ---

export default async function grepAppExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep_search",
    label: "Grep.app Code Search",
    description:
      "Search code across millions of public GitHub repositories using grep.app. Returns matching files, line numbers, and code snippets with optional filters for language, repository, and path.",
    promptSnippet: "Search public GitHub code for patterns, examples, or API usage",
    promptGuidelines: [
      "Use grep_search when you need real-world code examples or want to see how an API, function, or pattern is used in open source.",
      "Keep queries focused. Specific patterns return more useful snippets than broad keywords.",
      "Filter by language or repo when the answer depends on a particular ecosystem or project.",
      "grep.app searches public GitHub repositories only; private or non-GitHub code is not indexed.",
    ],
    parameters: GREP_SEARCH_PARAMS,
    renderResult: (result, options, theme, context) => {
      const details = result.details as GrepAppSearchDetails | undefined;
      const args = context.args as GrepAppSearchParams;
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
    },
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
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
    },
  });
}
