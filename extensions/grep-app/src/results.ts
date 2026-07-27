import type {
  GrepAppFacetBucket,
  GrepAppHit,
  GrepAppRawResponse,
  GrepAppRepoResult,
  GrepAppSearchDetails,
} from "./types.ts";

const MAX_SNIPPET_LENGTH = 400;
const MAX_SNIPPET_LINES = 8;
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

export function formatSearchResults(
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
