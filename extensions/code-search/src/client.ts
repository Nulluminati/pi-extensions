// Sourcegraph public search API client.
//
// Sourcegraph's anonymous stream endpoint answers SSE events: `matches`,
// `filters`, `progress`, `error`, and `done`. The full body is read as text
// once the server closes the stream (it always terminates with `done` after
// `count:` results are collected), then parsed in one pass.

import { DEFAULT_MAX_RESULTS } from "./constants.ts";
import type {
  CodeSearchParams,
  SourcegraphFilter,
  SourcegraphMatch,
  SourcegraphStreamData,
} from "./types.ts";

const SOURCEGRAPH_API_URL = "https://sourcegraph.com/.api/search/stream";
const REQUEST_TIMEOUT_MS = 30_000;
// Server-side search budget, kept below REQUEST_TIMEOUT_MS so zero-match
// queries terminate the stream (budget + facet overhead) before the client
// abort fires.
const SEARCH_BUDGET_TERM = "timeout:15s";
const USER_AGENT = "Mozilla/5.0 (compatible; pi-code-search/1.0)";
const GITHUB_REPO_PREFIX = "github.com/";

// --- URL building ---

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGithubPrefix(repository: string): string {
  return repository.startsWith(GITHUB_REPO_PREFIX)
    ? repository.slice(GITHUB_REPO_PREFIX.length)
    : repository;
}

export function buildSearchUrl(params: CodeSearchParams): string {
  const maxResults = params.max_results ?? DEFAULT_MAX_RESULTS;
  const terms = ["context:global", params.query];

  if (params.language) {
    terms.push(`lang:${params.language.trim()}`);
  }
  if (params.repo) {
    terms.push(`repo:^github\\.com/${escapeRegex(params.repo.trim())}$`);
  }
  if (params.path) {
    terms.push(`file:${params.path.trim()}`);
  }
  terms.push(`count:${maxResults}`);
  terms.push(SEARCH_BUDGET_TERM);

  const url = new URL(SOURCEGRAPH_API_URL);
  url.searchParams.set("q", terms.join(" "));
  url.searchParams.set("display", String(maxResults));
  return url.toString();
}

// --- SSE parsing ---

interface ParsedSseBlock {
  event: string;
  dataText: string | null;
}

function splitSseBlocks(raw: string): ParsedSseBlock[] {
  const blocks: ParsedSseBlock[] = [];
  for (const block of raw.split(/\n\n+/)) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) continue;
    blocks.push({ event, dataText: dataLines.join("\n") });
  }
  return blocks;
}

export function parseSearchStream(raw: string): SourcegraphStreamData {
  const matches: SourcegraphMatch[] = [];
  const languageBuckets = new Map<string, number>();
  const repositoryBuckets = new Map<string, number>();
  let totalResults: number | null = null;

  for (const block of splitSseBlocks(raw)) {
    if (block.dataText === null) continue;

    let data: unknown;
    try {
      data = JSON.parse(block.dataText);
    } catch {
      throw new Error("Sourcegraph returned an invalid response.");
    }

    if (block.event === "matches" && Array.isArray(data)) {
      matches.push(...(data as SourcegraphMatch[]));
    } else if (block.event === "filters" && Array.isArray(data)) {
      // Later filter events supersede earlier partial counts for the same bucket.
      for (const filter of data as SourcegraphFilter[]) {
        const count = Number(filter.count ?? 0);
        if (filter.kind === "lang" && filter.label) {
          languageBuckets.set(filter.label, count);
        } else if (filter.kind === "repo" && filter.label) {
          repositoryBuckets.set(stripGithubPrefix(filter.label), count);
        }
      }
    } else if (block.event === "progress" && data && typeof data === "object") {
      const matchCount = (data as { matchCount?: unknown }).matchCount;
      if (typeof matchCount === "number") {
        totalResults = matchCount;
      }
    } else if (block.event === "error" && data && typeof data === "object") {
      const message = (data as { message?: unknown }).message;
      throw new Error(`Sourcegraph search error: ${String(message ?? "unknown error")}`);
    }
  }

  return {
    matches,
    topLanguages: Array.from(languageBuckets, ([val, count]) => ({ val, count })),
    topRepositories: Array.from(repositoryBuckets, ([val, count]) => ({ val, count })),
    totalResults: totalResults ?? matches.length,
  };
}

// --- Fetch ---

export async function fetchSourcegraphSearch(
  url: string,
  signal: AbortSignal | undefined,
): Promise<SourcegraphStreamData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  if (signal) {
    const onCallerAbort = () => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error(
        "Sourcegraph rate limit hit (HTTP 429). Please wait a moment before searching again.",
      );
    }

    if (!response.ok) {
      throw new Error(`Sourcegraph API error (${response.status}): ${response.statusText}`);
    }

    const raw = await response.text();
    return parseSearchStream(raw);
  } finally {
    clearTimeout(timeout);
  }
}
