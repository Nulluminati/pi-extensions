# Web Search Extension

Web search and page fetch tools backed by a selectable search provider, with a `/websearch:select` picker for switching providers mid-session.

## What It Does

Registers two LLM-callable tools:

- **`web_search`** — Searches the web via the **currently selected provider** and returns results with titles, URLs, and snippets.
- **`web_fetch`** — Fetches the text content of any HTTP/HTTPS URL, stripping HTML by default (or returning raw HTML if requested). Provider-independent.

A `/websearch:select` command opens a fuzzy-filterable selector (the same `SelectList` component Pi's model picker uses) to choose the active provider. The choice persists across sessions; the active provider is visible in the selector and in `details.backend` of tool results, not in any status bar.

### Providers

| Provider | Description | Auth |
|----------|-------------|------|
| `synthetic` | Zero-retention search built for coding agents (synthetic.new) — **default** | `$SYNTHETIC_API_KEY`, Pi's `auth.json` (`$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`), or the synthetic provider's registered credentials |
| `brave` | Independent web index via the Brave Search API | `$BRAVE_API_KEY` ([get one](https://brave.com/search/api/)) |
| `searxng` | Self-hosted metasearch aggregating Google, Bing, DuckDuckGo, and more | `$SEARXNG_URL` (your instance); optionally `$SEARXNG_API_KEY` for token-protected instances |

SearXNG is self-hosted, so you run your own instance (see **Local SearXNG setup** below). Any other backend can be added by implementing the `SearchProvider` interface and appending to the provider list — the tool layer is provider-agnostic.

## Usage

### Switch providers

```
/websearch:select
```

Opens a selector listing every provider with its configured status. Pick one and it applies immediately to `web_search`.

Set one directly:

```
/websearch:select synthetic
/websearch:select brave
/websearch:select searxng
```

### web_search

The LLM calls this tool when it needs up-to-date information:

```
web_search({ query: "latest TypeScript release notes", max_results: 5 })
```

Results are returned as markdown with titles, URLs, and snippets. The model should cite sources when using search results. `max_results` is clamped to 1–10 (default 5).

### web_fetch

Read a specific page found via `web_search` or provided by the user:

```
web_fetch({ url: "https://example.com/docs", raw: false })
```

By default HTML is stripped to plain text. Set `raw: true` for the raw HTML.

## How It Works

### Provider abstraction

Each backend implements:

```typescript
interface SearchProvider {
  id: string;
  label: string;
  description: string;
  authHint: string;
  isConfigured(ctx): Promise<boolean>;
  search({ query, maxResults, signal, ctx }): Promise<SearchResult[]>;
}
```

Providers resolve their own credentials (environment, Pi's credential store, etc.) and return normalized `{ title, url, snippet }` results, so `web_search` stays backend-agnostic. `details.backend` records which provider produced each result.

### Provider selection

The active provider is held in closure scope (per Pi instance) and is chosen on `session_start`:

1. **Restore** the persisted choice from the session branch (`web-search-provider` entry), if any.
2. Otherwise **default to the first configured provider** (synthetic, then brave, then searxng).

`/websearch:select` (or `/websearch:select <id>`) updates it and calls `appendEntry("web-search-provider", ...)` so it survives reloads/restarts.

### web_search

1. **Resolve provider** — reads the active provider; falls back to the first registered.
2. **Validation** — ensures the query is non-empty; clamps `max_results` to 1–10.
3. **Config check** — if the active provider has no credentials, returns an error pointing at `authHint` and `/websearch:select`.
4. **Search** — delegates to the provider (e.g. Brave `GET /res/v1/web/search` or Synthetic `POST /v2/search`).
5. **Normalize + format** — builds `**Title**\nURL\nSnippet` per result. Synthetic excerpts are capped (~500 chars) and prefixed with their publish date.
6. **Truncation** — output over 50,000 characters is truncated and spilled to a temp file.
7. **Rendering** — collapsed summary (`🔍 Search: "query" — 5 results`), expanded preview (first 5 result titles), or an error line.

### web_fetch

1. **URL validation** — `http://`/`https://` only.
2. **HTTP fetch** — follows redirects, sends a `User-Agent` header, applies a 30-second timeout.
3. **Content-type check** — rejects binary content (`image/`, `video/`, `audio/`).
4. **Size guard** — rejects `Content-Length` over 1 MB before reading the body.
5. **HTML extraction** — strips `<script>`/`<style>`/`<noscript>`, converts block tags to newlines, decodes entities, collapses whitespace; extracts `<title>`.
6. **Truncation** — same 50,000-character limit with temp-file spillover.

### Truncation and spillover

Both tools use a shared `truncateWithSpill()` helper: output within the 50,000-character limit is returned inline; larger output is truncated and the full content written to `/tmp/pi-web-search-XXXXXX/content.txt`, with the path reported back.

## Key Design Decisions

- **One tool, selectable backend** — A single `web_search` tool whose provider switches via `/websearch:select`, mirroring how Pi's model picker swaps the active model. This keeps the tool surface stable for the LLM while letting the user change sources.
- **Closure-scoped active provider** — Each Pi instance (and each test) gets its own state, reset on factory invocation; no module-level leakage.
- **Persisted across sessions** — The chosen provider is stored as a custom session entry and restored on `session_start`, so reloading keeps your preference.
- **First-configured default** — When nothing is persisted, the first provider with credentials wins, so a fresh session just works without extra setup.
- **Provider resolves its own auth** — Brave reads `$BRAVE_API_KEY`; Synthetic reuses the same resolution as the synthetic model provider (`modelRegistry.getApiKeyForProvider("synthetic")` then `$SYNTHETIC_API_KEY`), so a single configured key covers both models and search; SearXNG needs only `$SEARXNG_URL` (plus optional `$SEARXNG_API_KEY` for token-protected instances).
- **No external npm dependencies** — Uses Node built-ins (`fetch`, `fs/promises`, `os`, `path`) and Pi's TUI components only. Pi transpiles extensions directly.
- **AbortSignal propagation** — The caller's signal is wired into a shared timeout controller across all network call sites (fetch, Brave, Synthetic, SearXNG) so requests cancel promptly.
- **No proxy support** — Requests use the platform `fetch`, which ignores `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. Proxied environments (common on managed corporate machines) are unsupported; use a transparent proxy or a VPN.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("web_search")` | Web search tool (uses the active provider) |
| `pi.registerTool("web_fetch")` | URL fetch + HTML-to-text tool |
| `pi.registerCommand("websearch:select")` | Provider selector / direct switch |
| `pi.on("session_start")` | Restores the persisted provider or picks the first configured one |
| `pi.appendEntry("web-search-provider")` | Persist the active provider |
| `ctx.ui.custom` + `SelectList` | Provider picker UI |
| `ctx.modelRegistry.getApiKeyForProvider` | Synthetic credential resolution |
| `renderResult` (tool option) | Custom TUI rendering for collapsed/expanded/partial/error states |

## Configuration

Set credentials for whichever providers you want to use:

```bash
export BRAVE_API_KEY=your_brave_key          # https://brave.com/search/api/
export SYNTHETIC_API_KEY=syn_...             # optional; auth.json also works
export SEARXNG_URL=http://localhost:8080     # your self-hosted instance
export SEARXNG_API_KEY=...                   # optional; only for token-protected instances
```

Then switch between them anytime with `/websearch:select`.

## Local SearXNG setup

SearXNG is a self-hosted metasearch engine. To use the `searxng` provider you
run your own instance and point `$SEARXNG_URL` at it. The fastest path on
Linux/macOS is the official Docker image.

### 1. Run an instance (Docker)

```bash
mkdir -p searxng

# Minimal settings that enable the JSON output format the extension needs.
# Without this, /search?format=json returns 403 Forbidden.
cat > searxng/settings.yml <<EOF
use_default_settings: true
search:
  formats: [html, json]
server:
  secret_key: "$(openssl rand -hex 32)"
EOF

docker run --rm -d --name searxng \
  -p 8080:8080 \
  -v "$PWD/searxng:/etc/searxng" \
  searxng/searxng:latest
```

Verify JSON works:

```bash
curl 'http://localhost:8080/search?q=test&format=json' | head -c 200
```

### 2. Point the extension at it

```bash
export SEARXNG_URL=http://localhost:8080
```

Then in Pi:

```
/websearch:select searxng
```

### Optional: token auth

If you expose the instance publicly, protect the JSON endpoint with a shared
secret and pass it via `$SEARXNG_API_KEY` (sent as `Authorization: Bearer`).
For a localhost instance you can leave this unset.

### Notes

- SearXNG has no `count`/`max_results` parameter — it returns a full aggregated
  page. The extension requests page 1 as JSON and slices to the requested
  `max_results`.
- Results without a `url` (e.g. answer/infobox items) are filtered out.
- Snippets are run through the same tag-stripping/entity-decoding cleanup as
  Brave results, since aggregated engines may emit markup.
