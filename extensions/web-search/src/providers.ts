import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTimeoutController } from "../../../lib/fetch-timeout.ts";
import { authPath } from "../../../lib/paths.ts";
import {
  BRAVE_SEARCH_API_URL,
  FETCH_TIMEOUT_MS,
  PROVIDER_STATE_TYPE,
  SEARXNG_API_KEY_ENV,
  SEARXNG_SEARCH_PATH,
  SEARXNG_URL_ENV,
  SYNTHETIC_SEARCH_API_URL,
  SYNTHETIC_SNIPPET_MAX_CHARS,
} from "./constants.ts";
import { decodeHtmlEntities, stripRemainingTags } from "./html.ts";
import type {
  BraveRawResponse,
  SearchProvider,
  SearchResult,
  SearXngRawResponse,
  SyntheticRawResponse,
} from "./types.ts";

// --- Providers ---

function getBraveApiKey(): string | undefined {
  const val = process.env.BRAVE_API_KEY;
  return val ? val.trim() || undefined : undefined;
}

function normalizeBraveResults(raw: BraveRawResponse): SearchResult[] {
  // Brave's title/description fields carry stray markup (<strong> emphasis on
  // query terms) and HTML entities (named, decimal &#39;, and hex &#x27;).
  // Strip tags before decoding so a decoded &lt; isn't mistaken for a tag, then
  // collapse the whitespace left behind by removed tags.
  return (raw.web?.results ?? []).map((r) => ({
    title: cleanSearchTextField(r.title),
    url: r.url ?? "",
    snippet: cleanSearchTextField(r.description),
  }));
}

/** Strip stray markup, collapse whitespace, and decode HTML entities in a raw
 * result text field. Shared by providers whose snippets may carry markup
 * (Brave wraps query terms in <strong>; SearXNG aggregates many engines). */
function cleanSearchTextField(text: string | undefined): string {
  return decodeHtmlEntities(
    stripRemainingTags(text ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

async function braveSearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController({
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  try {
    const url = new URL(BRAVE_SEARCH_API_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    const fetchInit: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: timeoutSignal,
    };
    const res = await fetch(url.toString(), fetchInit);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brave Search API error (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as BraveRawResponse;
    return normalizeBraveResults(raw);
  } finally {
    cleanup();
  }
}

async function getSyntheticApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const registered = await ctx.modelRegistry.getApiKeyForProvider("synthetic");
    if (registered) return registered;
  } catch {
    // Synthetic provider not registered yet; fall through to env.
  }
  const envVal = process.env.SYNTHETIC_API_KEY;
  return envVal ? envVal.trim() || undefined : undefined;
}

/** Trim a Synthetic text excerpt and prefix its publish date when available. */
function formatSyntheticSnippet(text: string | undefined, published: string | undefined): string {
  let snippet = (text ?? "").replace(/\s+/g, " ").trim();
  if (snippet.length > SYNTHETIC_SNIPPET_MAX_CHARS) {
    snippet = `${snippet.slice(0, SYNTHETIC_SNIPPET_MAX_CHARS).trimEnd()}…`;
  }
  if (published) {
    const datePart = published.slice(0, 10);
    if (datePart) {
      snippet = snippet ? `${datePart} — ${snippet}` : datePart;
    }
  }
  return snippet;
}

function normalizeSyntheticResults(raw: SyntheticRawResponse, maxResults: number): SearchResult[] {
  return (raw.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: formatSyntheticSnippet(r.text, r.published),
  }));
}

async function syntheticSearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController({
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  try {
    const fetchInit: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: timeoutSignal,
    };
    const res = await fetch(SYNTHETIC_SEARCH_API_URL, fetchInit);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Synthetic Search API error (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as SyntheticRawResponse;
    return normalizeSyntheticResults(raw, maxResults);
  } finally {
    cleanup();
  }
}

function getSearXngUrl(): string | undefined {
  const val = process.env[SEARXNG_URL_ENV];
  return val ? val.trim().replace(/\/+$/, "") || undefined : undefined;
}

function getSearXngApiKey(): string | undefined {
  const val = process.env[SEARXNG_API_KEY_ENV];
  return val ? val.trim() || undefined : undefined;
}

/** Keep only link-bearing results and clean each field. SearXNG aggregates many
 * engines, so snippets may carry markup the same way Brave's do. */
function normalizeSearXngResults(raw: SearXngRawResponse, maxResults: number): SearchResult[] {
  return (raw.results ?? [])
    .filter((r) => r.url)
    .slice(0, maxResults)
    .map((r) => ({
      title: cleanSearchTextField(r.title),
      url: r.url ?? "",
      snippet: cleanSearchTextField(r.content),
    }));
}

async function searxngSearch(
  query: string,
  maxResults: number,
  instanceUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController({
    timeoutMs: FETCH_TIMEOUT_MS,
    signal,
  });
  try {
    // SearXNG returns a full page of aggregated results (it has no count
    // parameter), so we request page 1 as JSON and slice to maxResults.
    const url = new URL(`${instanceUrl}${SEARXNG_SEARCH_PATH}`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: timeoutSignal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SearXNG API error (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as SearXngRawResponse;
    return normalizeSearXngResults(raw, maxResults);
  } finally {
    cleanup();
  }
}

/** Ordered provider catalog. The first configured provider is the default. */
export const PROVIDERS: SearchProvider[] = [
  {
    id: "synthetic",
    label: "Synthetic",
    description: "Zero-retention search built for coding agents (synthetic.new)",
    authHint: `Set $SYNTHETIC_API_KEY or add synthetic to ${authPath()}`,
    async isConfigured(ctx) {
      return Boolean(await getSyntheticApiKey(ctx));
    },
    async search({ query, maxResults, signal, ctx }) {
      const apiKey = await getSyntheticApiKey(ctx);
      if (!apiKey) {
        throw new Error(
          "No Synthetic API key found. Set $SYNTHETIC_API_KEY or configure the synthetic provider.",
        );
      }
      return syntheticSearch(query, maxResults, apiKey, signal);
    },
  },
  {
    id: "brave",
    label: "Brave Search",
    description: "Independent web index via the Brave Search API",
    authHint: "Set $BRAVE_API_KEY (https://brave.com/search/api/)",
    async isConfigured() {
      return Boolean(getBraveApiKey());
    },
    async search({ query, maxResults, signal }) {
      const apiKey = getBraveApiKey();
      if (!apiKey) {
        throw new Error("BRAVE_API_KEY environment variable is not set.");
      }
      return braveSearch(query, maxResults, apiKey, signal);
    },
  },
  {
    id: "searxng",
    label: "SearXNG",
    description: "Self-hosted metasearch aggregating Google, Bing, DuckDuckGo, and more",
    authHint:
      "Set $SEARXNG_URL to your instance (e.g. http://localhost:8080); enable JSON output in its settings",
    async isConfigured() {
      return Boolean(getSearXngUrl());
    },
    async search({ query, maxResults, signal }) {
      const instanceUrl = getSearXngUrl();
      if (!instanceUrl) {
        throw new Error(
          "SEARXNG_URL environment variable is not set. Point it at your SearXNG instance.",
        );
      }
      return searxngSearch(query, maxResults, instanceUrl, getSearXngApiKey(), signal);
    },
  },
];

export function getProvider(id: string | undefined): SearchProvider | undefined {
  if (!id) return undefined;
  return PROVIDERS.find((p) => p.id === id);
}

/** Reconstruct the persisted provider id from the session branch, if any. */
export function reconstructProviderId(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === PROVIDER_STATE_TYPE) {
      const data = entry.data as { provider?: string } | null;
      const id = data?.provider;
      if (id && getProvider(id)) return id;
    }
  }
  return undefined;
}
