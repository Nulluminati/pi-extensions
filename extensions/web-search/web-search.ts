/**
 * Web Search Extension
 *
 * Provides `web_search` and `web_fetch` tools backed by a selectable search
 * provider. Brave Search and Synthetic (synthetic.new) ship out of the box;
 * SearXNG and others can be added by extending the provider list below.
 *
 * Switch the active provider mid-session with `/websearch` (opens a selector)
 * or `/websearch <id>` (e.g. `/websearch synthetic`). The choice persists
 * across sessions and is shown in the footer.
 *
 * Provider auth:
 *   - brave:     $BRAVE_API_KEY  (https://brave.com/search/api/)
 *   - synthetic: $SYNTHETIC_API_KEY, ~/.pi/agent/auth.json, or the synthetic
 *                provider's registered credentials (same resolution as the
 *                synthetic model provider extension).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";

// --- Constants ---

const DEFAULT_MAX_RESULTS = 5;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 10;

const MAX_INLINE_CHARS = 50_000;
const MAX_FETCH_CONTENT_LENGTH = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

const TEMP_DIR_PREFIX = "pi-web-search-";
const TEMP_FILE_NAME = "content.txt";
const FETCH_PREVIEW_LINE_LIMIT = 15;
const SEARCH_PREVIEW_RESULT_LIMIT = 5;

const USER_AGENT = "Mozilla/5.0 (compatible; pi-web-search/1.0)";
const FETCH_ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"];

// Cap each Synthetic result's text excerpt so a single verbose page does not
// dominate the formatted output. Brave descriptions are already short.
const SYNTHETIC_SNIPPET_MAX_CHARS = 500;

const STATUS_KEY = "web-search";
const PROVIDER_STATE_TYPE = "web-search-provider";
const DEFAULT_PROVIDER_ID = "synthetic";

// Footer status indicator: a Nerd Font magnifier (nf-md-magnify) in a
// distinct accent hue with a greyed provider label, following the status-bar
// extension's icon/color conventions. The codepoint is built explicitly so
// the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf0349); // nf-md-magnify
export const ICON_COLOR = "accent";
export const TEXT_COLOR = "muted";

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const SYNTHETIC_SEARCH_API_URL = "https://api.synthetic.new/v2/search";
const SEARXNG_SEARCH_PATH = "/search";
const SEARXNG_URL_ENV = "SEARXNG_URL";
const SEARXNG_API_KEY_ENV = "SEARXNG_API_KEY";

// --- Types ---

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchArgs {
  query: string;
  maxResults: number;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
}

/**
 * A pluggable search backend. Providers resolve their own credentials from the
 * environment / context and return normalized results, so the tool layer stays
 * provider-agnostic. Add SearXNG (or any other source) by implementing this.
 */
interface SearchProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Short hint shown when the provider is selected but not configured. */
  readonly authHint: string;
  isConfigured(ctx: ExtensionContext): Promise<boolean>;
  search(args: SearchArgs): Promise<SearchResult[]>;
}

// --- HTML-to-text extraction ---

const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;
const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;
const BLOCK_CLOSER_REGEX =
  /<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;
const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;
const ANY_REMAINING_TAG_REGEX = /<[^>]+>/g;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const NUMERIC_HTML_ENTITY_REGEX = /&#(\d+);/g;
// Hex numeric character reference, e.g. &#x27; (apostrophe). Brave payloads use
// these alongside the decimal form, so both must be handled.
const HEX_HTML_ENTITY_REGEX = /&#x([0-9a-fA-F]+);/gi;
const HORIZONTAL_WHITESPACE_RUN = /[ \t]+/g;
const BLANK_LINE_RUN = /\n{3,}/g;

function stripNonContentBlocks(html: string): string {
  return html
    .replace(SCRIPT_BLOCK_REGEX, "")
    .replace(STYLE_BLOCK_REGEX, "")
    .replace(NOSCRIPT_BLOCK_REGEX, "");
}

function convertBlockTagsToNewlines(text: string): string {
  return text.replace(BLOCK_CLOSER_REGEX, "\n").replace(SELF_CLOSING_BR_REGEX, "\n");
}

function stripRemainingTags(text: string): string {
  return text.replace(ANY_REMAINING_TAG_REGEX, " ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(NUMERIC_HTML_ENTITY_REGEX, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(HEX_HTML_ENTITY_REGEX, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function collapseWhitespace(text: string): string {
  return text.replace(HORIZONTAL_WHITESPACE_RUN, " ").replace(BLANK_LINE_RUN, "\n\n");
}

function htmlToText(html: string): string {
  let text = stripNonContentBlocks(html);
  text = convertBlockTagsToNewlines(text);
  text = stripRemainingTags(text);
  text = decodeHtmlEntities(text);
  text = collapseWhitespace(text);
  return text.trim();
}

function extractTitle(html: string): string | undefined {
  const match = html.match(TITLE_TAG_REGEX);
  if (!match || match[1] === undefined) return undefined;
  const title = match[1].replace(ANY_REMAINING_TAG_REGEX, "").trim();
  return title || undefined;
}

// --- Content-type helpers ---

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes("text/html");
}

function assertTextContentType(contentType: string): void {
  if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.includes(prefix))) {
    throw new Error(
      `Unsupported content type: ${contentType}. web_fetch supports text pages only.`,
    );
  }
}

// --- HTTP fetch helpers ---

/**
 * Build an AbortController that fires after FETCH_TIMEOUT_MS and also aborts
 * when the caller's signal fires. All three network call sites share this so
 * timeout/cancellation behavior stays identical across providers.
 */
function createTimeoutController(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (callerSignal) {
    const onCallerAbort = () => controller.abort();
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function fetchUrlOrThrow(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController(signal);
  try {
    const init: RequestInit = {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
      signal: timeoutSignal,
    };
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return res;
  } finally {
    cleanup();
  }
}

async function extractBodyAsText(
  res: Response,
  contentType: string,
  raw: boolean,
): Promise<{ text: string; title?: string }> {
  const body = await res.text();
  if (!raw && isHtmlContentType(contentType)) {
    const title = extractTitle(body);
    return title !== undefined ? { text: htmlToText(body), title } : { text: htmlToText(body) };
  }
  return { text: body };
}

// --- Result formatting ---

function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }
  return results.map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`).join("\n\n");
}

// --- Providers ---

function getBraveApiKey(): string | undefined {
  const val = process.env.BRAVE_API_KEY;
  return val ? val.trim() || undefined : undefined;
}

interface BraveRawResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveRawResponse {
  web?: { results?: BraveRawResult[] };
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
  const { signal: timeoutSignal, cleanup } = createTimeoutController(signal);
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

interface SyntheticRawResult {
  url?: string;
  title?: string;
  text?: string;
  published?: string;
}

interface SyntheticRawResponse {
  results?: SyntheticRawResult[];
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
  const { signal: timeoutSignal, cleanup } = createTimeoutController(signal);
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

interface SearXngRawResult {
  url?: string;
  title?: string;
  content?: string;
}

interface SearXngRawResponse {
  results?: SearXngRawResult[];
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
  const { signal: timeoutSignal, cleanup } = createTimeoutController(signal);
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
const PROVIDERS: SearchProvider[] = [
  {
    id: "synthetic",
    label: "Synthetic",
    description: "Zero-retention search built for coding agents (synthetic.new)",
    authHint: "Set $SYNTHETIC_API_KEY or add synthetic to ~/.pi/agent/auth.json",
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

function getProvider(id: string | undefined): SearchProvider | undefined {
  if (!id) return undefined;
  return PROVIDERS.find((p) => p.id === id);
}

// --- Truncation ---

async function spillToTempFile(content: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const tempFile = join(tempDir, TEMP_FILE_NAME);
  await writeFile(tempFile, content, "utf8");
  return tempFile;
}

async function truncateWithSpill(
  text: string,
  maxChars: number,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const truncated = text.slice(0, maxChars);
  let fullOutputPath: string | undefined;
  try {
    fullOutputPath = await spillToTempFile(text);
  } catch {
    // If spill fails, still truncate but don't report path
  }

  const note = `\n\n[Response truncated at ${maxChars} characters. Full content was ${text.length} characters.]`;
  if (fullOutputPath) {
    return {
      text: `${truncated}${note}\n\nFull content saved to: ${fullOutputPath}`,
      truncated: true,
      fullOutputPath,
    };
  }

  return { text: truncated + note, truncated: true };
}

// --- Tool parameter schemas ---

const WEB_SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language search query",
    },
    max_results: {
      type: "number",
      description: `Maximum number of results to return (${MIN_MAX_RESULTS}-${MAX_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS})`,
    },
  },
  required: ["query"],
};

const WEB_FETCH_PARAMS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "HTTP or HTTPS URL to fetch",
    },
    raw: {
      type: "boolean",
      description: "If true, return raw HTML. If false (default), strip HTML to text.",
    },
  },
  required: ["url"],
};

// --- Extension ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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

/** Reconstruct the persisted provider id from the session branch, if any. */
function reconstructProviderId(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === PROVIDER_STATE_TYPE) {
      const data = entry.data as { provider?: string } | null;
      const id = data?.provider;
      if (id && getProvider(id)) return id;
    }
  }
  return undefined;
}

export default async function webSearchExtension(pi: ExtensionAPI) {
  // Active provider is closure-scoped so each Pi instance (and each test) gets
  // its own. session_start restores the persisted choice or picks the first
  // configured provider.
  let activeProviderId = DEFAULT_PROVIDER_ID;

  function activeProvider(): SearchProvider {
    const provider = getProvider(activeProviderId) ?? PROVIDERS[0];
    if (!provider) {
      // PROVIDERS is a non-empty constant; unreachable in practice, but keeps
      // the type checker honest under noUncheckedIndexedAccess.
      throw new Error("No search providers registered.");
    }
    return provider;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const provider = activeProvider();
    ctx.ui.setStatus(
      STATUS_KEY,
      `${ctx.ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ctx.ui.theme.fg(TEXT_COLOR, provider.id)}`,
    );
  }

  async function selectProvider(ctx: ExtensionCommandContext): Promise<SearchProvider | null> {
    const items: SelectItem[] = [];
    for (const provider of PROVIDERS) {
      const configured = await provider.isConfigured(ctx);
      const isActive = provider.id === activeProviderId;
      const description = configured
        ? provider.description
        : `${provider.description} — not configured (${provider.authHint})`;
      items.push({
        value: provider.id,
        label: isActive ? `${provider.label} (active)` : provider.label,
        description,
      });
    }

    const selectedId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Select Web Search Provider")), 1, 0),
      );

      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), 1, 0),
      );
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });

    return getProvider(selectedId ?? undefined) ?? null;
  }

  function applyProvider(provider: SearchProvider, ctx: ExtensionCommandContext) {
    activeProviderId = provider.id;
    pi.appendEntry(PROVIDER_STATE_TYPE, { provider: provider.id });
    updateStatus(ctx);
  }

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    const persisted = reconstructProviderId(ctx);
    if (persisted) {
      activeProviderId = persisted;
    } else {
      // Default to the first provider that has credentials configured.
      for (const provider of PROVIDERS) {
        if (await provider.isConfigured(ctx)) {
          activeProviderId = provider.id;
          break;
        }
      }
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // --- Tools ---

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the configured search provider (Brave, Synthetic, etc.). Returns a list of results with titles, URLs, and snippets. Use this tool when you need current information from the internet. Switch providers with the /websearch command.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when the answer likely requires up-to-date information not in your training data.",
      "Formulate concise, targeted queries for best results.",
      "Always cite sources with markdown hyperlinks when using search results in your response.",
    ],
    parameters: WEB_SEARCH_PARAMS,
    renderResult: (result, options, theme) => {
      const details = result.details as Record<string, unknown> | undefined;
      const query = String(details?.query ?? "");
      const count = Number(details?.resultCount ?? 0);
      const isError = Boolean(details?.isError);
      const errorText = isError
        ? result.content[0]?.type === "text"
          ? result.content[0].text
          : ""
        : "";
      if (isError) {
        return {
          render: (width: number) => [
            truncateToWidth(theme.fg("error", `✗ Search: "${query}" — ${errorText}`), width),
          ],
          invalidate: () => {},
        };
      }
      if (options.isPartial) {
        return {
          render: (width: number) => [
            truncateToWidth(theme.fg("warning", `🔍 Searching: "${query}"...`), width),
          ],
          invalidate: () => {},
        };
      }
      if (options.expanded) {
        const results = details?.results as SearchResult[] | undefined;
        if (results && results.length > 0) {
          const limit = SEARCH_PREVIEW_RESULT_LIMIT;
          const visible = results.slice(0, limit);
          let text = "";
          for (const r of visible) {
            text += `${theme.fg("dim", `• ${r.title}`)}\n`;
          }
          if (results.length > limit) {
            text += theme.fg("muted", `... and ${results.length - limit} more results`);
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
      const label = count === 0 ? "no results" : `${count} result${count !== 1 ? "s" : ""}`;
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("success", `🔍 Search: "${query}" — ${label}`), width),
        ],
        invalidate: () => {},
      };
    },
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const provider = activeProvider();
      const query = String(params.query ?? "");

      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required" }],
          details: { query: "", backend: provider.id, resultCount: 0, isError: true },
        };
      }

      const configured = await provider.isConfigured(ctx);
      if (!configured) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${provider.label} is not configured. ${provider.authHint} Switch providers with /websearch.`,
            },
          ],
          details: { query, backend: provider.id, resultCount: 0, isError: true },
        };
      }

      let maxResults = Number(params.max_results) || DEFAULT_MAX_RESULTS;
      maxResults = Math.max(MIN_MAX_RESULTS, Math.min(MAX_MAX_RESULTS, maxResults));

      onUpdate?.({
        content: [{ type: "text", text: `Searching ${provider.label} for: "${query}"...` }],
        details: { query, backend: provider.id, resultCount: 0 },
      });

      try {
        const results = await provider.search({ query, maxResults, signal, ctx });
        const text = formatSearchResults(query, results);
        const {
          text: displayText,
          truncated,
          fullOutputPath,
        } = await truncateWithSpill(text, MAX_INLINE_CHARS);

        const details: Record<string, unknown> = {
          query,
          backend: provider.id,
          resultCount: results.length,
          results,
        };
        if (truncated) {
          details.truncation = { truncated: true, originalLength: text.length };
          if (fullOutputPath) details.fullOutputPath = fullOutputPath;
        }

        return {
          content: [{ type: "text", text: displayText }],
          details,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { query, backend: provider.id, resultCount: 0, isError: true },
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch the content of an HTTP or HTTPS URL. Returns page text with HTML stripped (or raw HTML if raw=true). Use this to read a specific web page found via web_search or provided by the user.",
    promptSnippet: "Fetch a specific URL to read its content",
    promptGuidelines: [
      "Use web_fetch when you need to read the full content of a specific URL.",
      "Prefer web_search first to find relevant URLs, then web_fetch to read them.",
      "Set raw=true only if you specifically need the raw HTML.",
    ],
    parameters: WEB_FETCH_PARAMS,
    renderResult: (result, options, theme) => {
      const details = result.details as Record<string, unknown> | undefined;
      const url = String(details?.url ?? "");
      const isError = Boolean(details?.isError);
      const errorText = isError
        ? result.content[0]?.type === "text"
          ? result.content[0].text
          : ""
        : "";
      if (isError) {
        return {
          render: (width: number) => [
            truncateToWidth(theme.fg("error", `✗ Fetch: ${url} — ${errorText}`), width),
          ],
          invalidate: () => {},
        };
      }
      if (options.isPartial) {
        return {
          render: (width: number) => [
            truncateToWidth(theme.fg("warning", `📄 Fetching: ${url}...`), width),
          ],
          invalidate: () => {},
        };
      }
      if (options.expanded) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        const fullOutputPath = details?.fullOutputPath as string | undefined;
        const lines = text.split("\n");
        const visible = lines.slice(0, FETCH_PREVIEW_LINE_LIMIT);
        let preview = "";
        for (const line of visible) {
          preview += `${theme.fg("dim", line)}\n`;
        }
        if (lines.length > FETCH_PREVIEW_LINE_LIMIT) {
          const remaining = lines.length - FETCH_PREVIEW_LINE_LIMIT;
          let ellipsis = `... and ${remaining} more line${remaining !== 1 ? "s" : ""}`;
          if (fullOutputPath) {
            ellipsis += ` — full content at ${fullOutputPath}`;
          }
          preview += theme.fg("muted", ellipsis);
        }
        return {
          render: (width: number) => wrapMultilineText(preview.trimEnd(), width),
          invalidate: () => {},
        };
      }
      const title = details?.title ? ` — ${details.title}` : "";
      const contentLength = details?.contentLength as number | undefined;
      const size = contentLength != null ? ` (${formatBytes(contentLength)})` : "";
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("success", `📄 Fetch: ${url}${title}${size}`), width),
        ],
        invalidate: () => {},
      };
    },
    execute: async (_toolCallId, params, signal, onUpdate, _ctx) => {
      const url = String(params.url ?? "");
      if (!url) {
        return {
          content: [{ type: "text", text: "Error: url is required" }],
          details: { url: "", isError: true },
        };
      }

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Invalid URL protocol. Only http and https are supported: ${url}`,
            },
          ],
          details: { url, isError: true },
        };
      }

      const raw = Boolean(params.raw);

      onUpdate?.({
        content: [{ type: "text", text: `Fetching: ${url}...` }],
        details: { url },
      });

      try {
        const res = await fetchUrlOrThrow(url, signal);
        const contentType = res.headers.get("content-type") ?? "";
        assertTextContentType(contentType);

        // Pre-check content length to avoid loading huge responses into memory
        const contentLengthHeader = res.headers.get("content-length");
        const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
        if (contentLength !== undefined && contentLength > MAX_FETCH_CONTENT_LENGTH) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Response body too large (${formatBytes(contentLength)}). Maximum is ${formatBytes(MAX_FETCH_CONTENT_LENGTH)}.`,
              },
            ],
            details: { url, contentLength, isError: true },
          };
        }

        const { text, title } = await extractBodyAsText(res, contentType, raw);

        const {
          text: displayText,
          truncated,
          fullOutputPath,
        } = await truncateWithSpill(text, MAX_INLINE_CHARS);

        const header = [
          `URL: ${url}`,
          title ? `Title: ${title}` : undefined,
          contentType ? `Content-Type: ${contentType}` : undefined,
          contentLength !== undefined ? `Content-Length: ${contentLength}` : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n");

        const body = `${header}\n\n${displayText}`;

        const details: Record<string, unknown> = {
          url,
          contentType: contentType || undefined,
          contentLength,
        };
        if (title) details.title = title;
        if (truncated) {
          details.truncation = { truncated: true, originalLength: text.length };
          if (fullOutputPath) details.fullOutputPath = fullOutputPath;
        }

        return {
          content: [{ type: "text", text: body }],
          details,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { url },
        };
      }
    },
  });

  // --- Command ---

  pi.registerCommand("websearch", {
    description:
      "Select or switch the web search provider: /websearch | /websearch <brave|synthetic>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;

      const requested = args.trim();
      if (requested) {
        const provider = getProvider(requested);
        if (!provider) {
          const available = PROVIDERS.map((p) => p.id).join(", ");
          ctx.ui.notify(`Unknown search provider "${requested}". Available: ${available}`, "error");
          return;
        }
        applyProvider(provider, ctx);
        const configured = await provider.isConfigured(ctx);
        const note = configured ? "" : ` — not configured (${provider.authHint})`;
        ctx.ui.notify(
          `Web search provider set to ${provider.label}${note}`,
          configured ? "info" : "warning",
        );
        return;
      }

      const provider = await selectProvider(ctx);
      if (!provider) return; // cancelled
      applyProvider(provider, ctx);
      const configured = await provider.isConfigured(ctx);
      const note = configured ? "" : ` — not configured (${provider.authHint})`;
      ctx.ui.notify(
        `Web search provider set to ${provider.label}${note}`,
        configured ? "info" : "warning",
      );
    },
  });
}
