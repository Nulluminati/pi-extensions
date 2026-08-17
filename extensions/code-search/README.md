# Code Search Extension

Search code across millions of public GitHub repositories via [Sourcegraph](https://sourcegraph.com). One LLM-callable tool, no API key, no MCP — direct HTTP to Sourcegraph's public search stream API.

## What It Does

Registers a single LLM-callable tool:

- **`code_search`** — Searches public GitHub code for a pattern and returns matching files, line numbers, and code snippets. Supports optional filters for language, repository (`owner/repo`), and path.

The tool gives the agent access to real-world code examples and library usage patterns, so it can answer "how is this API used in practice?" without resorting to stale training data.

## Usage

The agent calls the tool when it needs to ground an answer in actual open-source code:

```
code_search({ query: "useEffect cleanup function pattern" })
```

Filter by language, repository, or path:

```
code_search({
  query: "async error handling",
  language: "rust",
  repo: "tokio-rs/tokio",
  path: "src",
  max_results: 15,
})
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | yes | Search query — terms are ANDed; quote exact strings (e.g., `"useEffect cleanup"`). Parentheses only work within a single term |
| `language` | no | Filter by language, e.g., `"Python"`, `"TypeScript"` |
| `repo` | no | Filter to one repository in `owner/repo` format |
| `path` | no | Restrict to a subdirectory |
| `max_results` | no | 1–50, defaults to 10 |

Results are grouped by repository, ranked by match count, and include the matching code in a fenced block tagged with the language reported by the API. Each result also lists the matching line numbers and the branch (or short commit SHA) it was found on.

## How It Works

### Search

1. **Validation** — Empty queries and oversize parameters are rejected with structured error results. Multi-term queries where any term contains parentheses are rejected with guidance: Sourcegraph's public API silently returns zero matches for them, and a false negative is worse than an error. Single parenthesized terms (e.g., `MarshalJSON()`) and quoted phrases work fine. The `max_results` value is clamped to 1–50 (default 10).
2. **URL build** — The query plus any active filters are compiled into a single Sourcegraph query string: `context:global <query> lang:<language> repo:^github\.com/<owner/repo>$ file:<path> count:<N> timeout:15s`, with `display=<N>` as a URL parameter. The default is Sourcegraph's standard mode where terms are ANDed and quoted phrases match exactly.
3. **Fetch** — A 60-second timeout aborts the request if the API is slow. The caller signal is wired into the same abort controller.
4. **Stream parse** — Sourcegraph answers with server-sent events. The client reads the full body once the stream terminates (`done`) and parses `matches`, `filters`, `progress`, and `error` events in one pass. Stream-level errors surface as readable tool errors.
5. **Normalize** — Each match's `repository` (`github.com/owner/repo`) is stripped to `owner/repo`; `lineMatches` provide both the line numbers and the snippet text; the API's `language` field tags fenced code blocks.
6. **Group and rank** — Matches are grouped by repository; the result list is sorted by total match count, descending.
7. **Cache** — Identical repeat queries within 60 seconds (up to 20 entries, per Pi instance) are served from an in-memory cache without refetching. Errors are never cached, so retries always hit the network.

### Result rendering

The tool registers a `renderResult` callback that draws one of four states to the TUI:

- **In progress** — a dim "searching" line with a magnifying glass
- **Collapsed** — `🔍 Code search: "query" — 1,234 matches in 17 repos (10 shown)` in the success hue
- **Expanded** — a short list of the top repositories, plus a "… and N more" tail
- **Error** — the error message in the error hue, prefixed with an X

## Key Design Decisions

- **Sourcegraph over grep.app** — grep.app's API is deployed behind Vercel's bot challenge, which 429s every non-browser client. Sourcegraph's public stream API answers anonymous requests without a challenge.
- **Standard mode only** — Sourcegraph's regexp mode (`patternType=regexp`) silently returns false zeros for plausible patterns on the public instance (e.g., `MarshalJSON\s` matched nothing while `func\s` matched 230), and multi-term queries containing parentheses return order-dependent zeros. The tool therefore stays in standard mode, where single terms (punctuation included) and quoted phrases are reliable, and rejects the broken query class client-side.
- **No API key** — Sourcegraph's public code search is unauthenticated. Anyone can use the tool without provisioning credentials.
- **No MCP** — The extension is a direct HTTP client. There is no stdio bridge, no subprocess, no extra layer to debug.
- **Whole-body SSE parsing** — The stream is read to completion (`done` always terminates it after `count:` results) and parsed in one pass instead of incrementally, keeping the parser synchronous and testable.
- **Structured error results** — Every failure path returns `{ content, details: { isError: true } }` so the agent can read the error without exception unwrapping.
- **Bounded expansion** — The expanded TUI preview only lists the first 5 repositories; the full result is still in the tool's content for the LLM to read.
- **Caller signal plumbed through** — The AbortSignal from Pi is wired into the fetch's internal controller, so cancelling an agent turn also cancels the in-flight HTTP request.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("code_search")` | The LLM-callable search tool |
| Tool `renderResult` option | Custom TUI rendering (collapsed/expanded/partial/error) |
| Global `fetch` | Direct HTTP to the Sourcegraph stream API |

## Configuration

None. Sourcegraph's public search requires no credentials.
