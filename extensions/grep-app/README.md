# Grep.app Code Search Extension

Search code across millions of public GitHub repositories via [grep.app](https://grep.app). One LLM-callable tool, no API key, no MCP — direct HTTP to the grep.app search API.

## What It Does

Registers a single LLM-callable tool:

- **`grep_search`** — Searches public GitHub code for a pattern and returns matching files, line numbers, and code snippets. Supports optional filters for language, repository (`owner/repo`), and path.

The tool gives the agent access to real-world code examples and library usage patterns, so it can answer "how is this API used in practice?" without resorting to stale training data.

## Usage

The agent calls the tool when it needs to ground an answer in actual open-source code:

```
grep_search({ query: "useEffect cleanup function pattern" })
```

Filter by language, repository, or path:

```
grep_search({
  query: "async error handling",
  language: "rust",
  repo: "tokio-rs/tokio",
  path: "src",
  max_results: 15,
})
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | yes | Search pattern (grep.app uses RE2 syntax) |
| `language` | no | Filter by language, e.g. `"Python"`, `"TypeScript"` |
| `repo` | no | Filter to one repository in `owner/repo` format |
| `path` | no | Restrict to a subdirectory |
| `max_results` | no | 1–50, defaults to 10 |

Results are grouped by repository, ranked by match count, and include the matching code in a fenced block tagged with the detected language. Each result also lists the matching line numbers and the branch it was found on.

## How It Works

### Search

1. **Validation** — Empty queries and oversize parameters are rejected with structured error results. The `max_results` value is clamped to 1–50 (default 10).
2. **URL build** — `query` plus any active filters are encoded into grep.app's `f.lang`, `f.repo`, and `f.path` facet parameters.
3. **Fetch** — A 30-second timeout aborts the request if the API is slow. The caller signal is wired into the same abort controller.
4. **429 / 5xx handling** — Rate-limit and server errors surface as a readable error message in the tool result.
5. **Normalize** — Each hit's HTML snippet is stripped of tags, decoded, and run through `data-line="N"` extraction to pull matching line numbers. The language is inferred from the file extension via a built-in map.
6. **Group and rank** — Hits are grouped by repository; the result list is sorted by total match count, descending.

### Result rendering

The tool registers a `renderResult` callback that draws one of four states to the TUI:

- **In progress** — a dim "searching" line with a magnifying glass
- **Collapsed** — `🔍 Grep: "query" — 1,234 matches in 17 repos (10 shown)` in the success hue
- **Expanded** — a short list of the top repositories, plus a "… and N more" tail
- **Error** — the error message in the error hue, prefixed with an X

## Key Design Decisions

- **No API key** — grep.app is unauthenticated. Anyone can use the tool without provisioning credentials.
- **No MCP** — The extension is a direct HTTP client. There is no stdio bridge, no subprocess, no extra layer to debug.
- **Structured error results** — Every failure path returns `{ content, details: { isError: true } }` so the agent can read the error without exception unwrapping.
- **Language inference from extension** — The API doesn't return a language field, so the tool infers it from the file extension via a static map. Snippets for known languages are wrapped in fenced code blocks; unknown extensions render as plain text.
- **Bounded expansion** — The expanded TUI preview only lists the first 5 repositories; the full result is still in the tool's content for the LLM to read.
- **Caller signal plumbed through** — The AbortSignal from Pi is wired into the fetch's internal controller, so cancelling an agent turn also cancels the in-flight HTTP request.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("grep_search")` | The LLM-callable search tool |
| Tool `renderResult` option | Custom TUI rendering (collapsed/expanded/partial/error) |
| Global `fetch` | Direct HTTP to the grep.app API |

## Configuration

None. grep.app requires no credentials.
