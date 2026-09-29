import { stripGithubPrefix } from "./client.ts";
import type {
  CodeSearchDetails,
  CodeSearchFacetBucket,
  CodeSearchFileResult,
  CodeSearchRepoResult,
  SourcegraphMatch,
  SourcegraphStreamData,
} from "./types.ts";

const MAX_SNIPPET_LENGTH = 400;
const MAX_SNIPPET_LINES = 8;

// --- Pure utility functions ---

function fallbackLanguageFromPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extension || "text";
}

function shortRef(match: SourcegraphMatch): string {
  const branch = match.branches?.find((candidate) => candidate.trim().length > 0);
  if (branch) return branch;
  return (match.commit ?? "").slice(0, 7) || "unknown";
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

function normalizeMatch(match: SourcegraphMatch): {
  repository: string;
  filePath: string;
  branch: string;
  totalMatches: number;
  lineNumbers: number[];
  language: string;
  codeSnippet: string;
} {
  const repository = stripGithubPrefix(match.repository ?? "unknown");
  const filePath = match.path ?? "unknown";
  const lineMatches = match.lineMatches ?? [];
  const lineNumbers = lineMatches
    .map((lineMatch) => lineMatch.lineNumber)
    .filter((lineNumber): lineNumber is number => typeof lineNumber === "number");
  const snippetLines = lineMatches
    .map((lineMatch) => lineMatch.line ?? "")
    .filter((line) => line.length > 0);
  const language = (match.language ?? fallbackLanguageFromPath(filePath)).toLowerCase();

  return {
    repository,
    filePath,
    branch: shortRef(match),
    totalMatches: lineNumbers.length,
    lineNumbers,
    language,
    codeSnippet: formatCodeSnippet(snippetLines.join("\n"), language),
  };
}

function groupResultsByRepo(matches: SourcegraphMatch[]): CodeSearchRepoResult[] {
  const repoMap = new Map<string, CodeSearchRepoResult>();

  for (const match of matches) {
    const normalized = normalizeMatch(match);
    let repoResult = repoMap.get(normalized.repository);
    if (!repoResult) {
      repoResult = { repository: normalized.repository, matchesCount: 0, files: [] };
      repoMap.set(normalized.repository, repoResult);
    }

    const file: CodeSearchFileResult = {
      filePath: normalized.filePath,
      branch: normalized.branch,
      totalMatches: normalized.totalMatches,
      lineNumbers: normalized.lineNumbers,
      language: normalized.language,
      codeSnippet: normalized.codeSnippet,
    };
    repoResult.files.push(file);
    repoResult.matchesCount += normalized.totalMatches;
  }

  return Array.from(repoMap.values()).sort((a, b) => b.matchesCount - a.matchesCount);
}

function formatRepoResult(repo: CodeSearchRepoResult): string {
  const header = `## ${repo.repository} (${repo.matchesCount} match${repo.matchesCount !== 1 ? "es" : ""})`;
  const files = repo.files
    .map((file) => {
      const lines = file.lineNumbers.length > 0 ? ` (lines ${file.lineNumbers.join(", ")})` : "";
      const parts = [`### ${file.filePath}${lines}`, `Ref: ${file.branch}`, file.codeSnippet];
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${files}`;
}

function formatBucketList(buckets: CodeSearchFacetBucket[]): string {
  if (buckets.length === 0) return "None";
  return buckets.map((bucket) => `- ${bucket.val}: ${bucket.count}`).join("\n");
}

export function formatSearchResults(
  query: string,
  data: SourcegraphStreamData,
  maxResults: number,
): { text: string; details: CodeSearchDetails } {
  const limitedMatches = data.matches.slice(0, maxResults);
  const repoResults = groupResultsByRepo(limitedMatches);

  const topLanguages = data.topLanguages.slice(0, 5);
  const topRepositories = data.topRepositories.slice(0, 5);

  const details: CodeSearchDetails = {
    query,
    totalResults: data.totalResults,
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
    `# Code search results for "${query}"`,
    `Total matches: ${details.totalResults.toLocaleString()}`,
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
