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

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "pi";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_PROVIDER_ID,
  ICON_COLOR,
  MAX_FETCH_CONTENT_LENGTH,
  MAX_INLINE_CHARS,
  MAX_MAX_RESULTS,
  MIN_MAX_RESULTS,
  PROVIDER_STATE_TYPE,
  STATUS_ICON,
  STATUS_KEY,
  TEXT_COLOR,
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
import { truncateWithSpill } from "./src/truncation.ts";
import type { SearchProvider } from "./src/types.ts";

export { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./src/constants.ts";

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
    renderResult: renderSearchResult,
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
    renderResult: renderFetchResult,
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
