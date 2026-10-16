/**
 * Web Search Extension
 *
 * Provides `web_search` and `web_fetch` tools backed by a selectable search
 * provider. Brave Search and Synthetic (synthetic.new) ship out of the box;
 * SearXNG and others can be added by extending the provider list below.
 *
 * Switch the active provider mid-session with `/websearch:select` (opens a
 * selector) or `/websearch:select <id>` (e.g. `/websearch:select synthetic`).
 * The choice persists across sessions. The active provider is not rendered in
 * any bar; it is visible in the selector and in `details.backend` of tool
 * results.
 *
 * Provider auth:
 *   - brave:     $BRAVE_API_KEY  (https://brave.com/search/api/)
 *   - synthetic: $SYNTHETIC_API_KEY, $PI_CODING_AGENT_DIR/auth.json, or the
 *                synthetic provider's registered credentials (same resolution
 *                as the synthetic model provider extension).
 */

import type { SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { createSearchableSelectModal } from "../../lib/searchable-select.ts";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_PROVIDER_ID,
  MAX_FETCH_CONTENT_LENGTH,
  MAX_INLINE_CHARS,
  MAX_MAX_RESULTS,
  MIN_MAX_RESULTS,
  PROVIDER_STATE_TYPE,
} from "./src/constants.ts";
import { assertTextContentType } from "./src/html.ts";
import { extractBodyAsText, fetchUrlOrThrow } from "./src/http.ts";
import { getProvider, PROVIDERS, reconstructProviderId } from "./src/providers.ts";
import {
  formatBytes,
  formatSearchResults,
  renderFetchResult,
  renderSearchResult,
} from "./src/rendering.ts";
import { WEB_FETCH_PARAMS, WEB_SEARCH_OUTPUT, WEB_SEARCH_PARAMS } from "./src/schemas.ts";
import { truncateWithSpill } from "./src/truncation.ts";
import type { SearchProvider, SearchResult } from "./src/types.ts";

// --- Extension ---
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

  async function selectProvider(ctx: ExtensionCommandContext): Promise<SearchProvider | null> {
    const items: SelectItem[] = [];
    for (const provider of PROVIDERS) {
      const configured = await provider.isConfigured(ctx);
      const description = configured
        ? provider.description
        : `${provider.description} — not configured (${provider.authHint})`;
      items.push({
        value: provider.id,
        label: configured ? provider.label : `${provider.label} (not configured)`,
        description,
      });
    }

    if (ctx.mode !== "tui") {
      const selectedId = await ctx.ui.select(
        "Select Web Search Provider",
        items.map((item) => item.value),
      );
      return getProvider(selectedId) ?? null;
    }

    const selectedId = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
      createSearchableSelectModal({
        tui,
        theme,
        keybindings,
        items,
        activeValue: activeProviderId,
        title: "Web Search",
        maxVisible: 10,
        noMatchText: "No matching providers",
        onSelect: done,
        onCancel: () => done(null),
      }),
    );

    return getProvider(selectedId ?? undefined) ?? null;
  }

  function applyProvider(provider: SearchProvider) {
    activeProviderId = provider.id;
    pi.appendEntry(PROVIDER_STATE_TYPE, { provider: provider.id });
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
  });

  // --- Tools ---

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the configured search provider (Brave, Synthetic, etc.). Returns a list of results with titles, URLs, and snippets. Use this tool when you need current information from the internet. Switch providers with the /websearch:select command.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when the answer likely requires current information not in your training data, or to discover sources when you do not know where the answer is.",
      "Formulate concise, targeted queries for best results.",
      "Always cite sources with markdown hyperlinks when using search results in your response.",
    ],
    parameters: WEB_SEARCH_PARAMS,
    outputSchema: WEB_SEARCH_OUTPUT,
    renderResult: renderSearchResult,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const provider = activeProvider();
      const query = String(params.query ?? "");
      const data = (results: SearchResult[] = [], error?: string) => ({
        query,
        backend: provider.id,
        resultCount: results.length,
        results,
        ...(error ? { error } : {}),
      });

      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required" }],
          isError: true,
          details: { query: "", backend: provider.id, resultCount: 0, isError: true },
          structuredContent: data([], "Error: query is required"),
        };
      }

      const configured = await provider.isConfigured(ctx);
      if (!configured) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${provider.label} is not configured. ${provider.authHint} Switch providers with /websearch:select.`,
            },
          ],
          isError: true,
          details: { query, backend: provider.id, resultCount: 0, isError: true },
          structuredContent: data(
            [],
            `Error: ${provider.label} is not configured. ${provider.authHint} Switch providers with /websearch:select.`,
          ),
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
          structuredContent: data(results),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
          details: { query, backend: provider.id, resultCount: 0, isError: true },
          structuredContent: data([], `Error: ${message}`),
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
      "When the user supplies a URL or you already know the page, fetch it directly. Search first only when you still need to find the source.",
      "Set raw=true only if you specifically need the raw HTML.",
    ],
    parameters: WEB_FETCH_PARAMS,
    renderResult: renderFetchResult,
    execute: async (_toolCallId, params, signal, onUpdate, _ctx) => {
      const url = String(params.url ?? "");
      if (!url) {
        return {
          content: [{ type: "text", text: "Error: url is required" }],
          isError: true,
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
          isError: true,
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
            isError: true,
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
          isError: true,
          details: { url, isError: true },
        };
      }
    },
  });

  // --- Command ---

  pi.registerCommand("websearch:select", {
    description:
      "Select or switch the web search provider: /websearch:select | /websearch:select <brave|synthetic>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;

      const requested = args.trim().replace(/^select\s*/, "");
      if (requested) {
        const provider = getProvider(requested);
        if (!provider) {
          const available = PROVIDERS.map((p) => p.id).join(", ");
          ctx.ui.notify(`Unknown search provider "${requested}". Available: ${available}`, "error");
          return;
        }
        applyProvider(provider);
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
      applyProvider(provider);
      const configured = await provider.isConfigured(ctx);
      const note = configured ? "" : ` — not configured (${provider.authHint})`;
      ctx.ui.notify(
        `Web search provider set to ${provider.label}${note}`,
        configured ? "info" : "warning",
      );
    },
  });
}
