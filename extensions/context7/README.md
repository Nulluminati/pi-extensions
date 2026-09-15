# Context7 Extension

Pi-native Context7 documentation tools. Direct HTTP to the Context7 API with a persistent searchable cache. Equivalent to the Context7 MCP server but built directly into Pi.

## What It Does

This extension registers three LLM-callable tools for accessing up-to-date library documentation from [Context7](https://context7.com/):

- **`context7_resolve_library_id`** — Maps a library or package name to a Context7 library ID. Useful when you know the npm/pypi/crate name but not the exact Context7 identifier.
- **`context7_get_library_docs`** — Fetches curated documentation for a library by ID or by name (auto-resolves if needed). Returns keyword-ranked sections with a docRef for later raw retrieval.
- **`context7_get_cached_doc_raw`** — Reads the full raw cached document from a previous `context7_get_library_docs` call. Use this when the curated summary was insufficient and you need the complete un-truncated text.

These tools let the agent look up library APIs, configuration options, and usage patterns without relying on training data that may be outdated.

## Usage

### context7_resolve_library_id

Call this when you need to find the Context7 ID for a library:

```
context7_resolve_library_id({ libraryName: "next.js" })
```

The tool searches Context7, scores results by reputation and benchmark scores, and returns the best match. If multiple libraries have similar names, it flags the result as ambiguous so you can choose the right one.

You can also pass an optional `query` to help rank the match:

```
context7_resolve_library_id({
  libraryName: "react",
  query: "server components"
})
```

### context7_get_library_docs

The primary docs lookup tool. Pass an exact `libraryId` if you already know it:

```
context7_get_library_docs({
  libraryId: "/vercel/next.js",
  query: "how to use middleware"
})
```

Or pass just `libraryName` and let it auto-resolve:

```
context7_get_library_docs({
  libraryName: "next.js",
  query: "how to use middleware"
})
```

Optional parameters:
- `topic` — narrows the docs to a specific area (e.g., `"authentication"`)
- `page` — logical page number for paginated retrieval when the first result is too long

The returned text is curated: relevant sections are selected and ranked by keyword match, then truncated to ~12,000 characters with a header showing library metadata and a footer with the `docRef`.

### context7_get_cached_doc_raw

Use this after `context7_get_library_docs` when you need the complete raw text that was truncated in the curated view:

```
context7_get_cached_doc_raw({ docRef: "ctx7:docs:abc123..." })
```

You can also search by metadata fields if you don't have the docRef:

```
context7_get_cached_doc_raw({
  libraryName: "next.js",
  query: "how to use middleware"
})
```

If multiple cached docs match, the tool returns a list of candidates rather than guessing.

## How It Works

### context7_resolve_library_id

1. **Cache check** — Looks up `(libraryName, query)` in the resolve cache. If fresh, returns immediately.
2. **API search** — Calls `GET /v2/libs/search` on Context7 with the library name and optional query.
3. **Result scoring** — Scores each result by benchmark score, trust score, snippet count, title match, and ID match.
4. **Ambiguity detection** — If the top result doesn't win by a clear margin (≥8 points) or exact match, the result is flagged as ambiguous.
5. **Cache write** — Stores the result list in the resolve cache with a TTL (default 7 days).
6. **Stale fallback** — If the network request fails and a stale cache entry exists, the stale results are returned with a warning.

### context7_get_library_docs

1. **Library ID resolution** — If `libraryId` is not provided, calls `context7_resolve_library_id` internally. If ambiguous, returns the candidate list and stops.
2. **Cache check** — Computes a `docRef` from `(libraryId, effectiveQuery, page)` and checks the docs cache. If fresh, returns the cached curated text.
3. **API fetch** — Calls `GET /v2/context` on Context7 with the library ID and query.
4. **Curation** — Splits the raw text into sections, scores each section by keyword overlap with the query/topic, selects the top-scoring sections (up to 12), and assembles them into a curated document with a header and footer.
5. **Truncation** — If the curated text exceeds ~12,000 characters, it is truncated. A note in the footer tells the LLM it can call `context7_get_cached_doc_raw` for the full raw text.
6. **Cache write** — Stores both the raw and curated text in the docs cache with a TTL (default 1 day).
7. **Stale fallback** — If the network request fails and a stale docs cache entry exists, the stale curated text is returned with a warning.

### context7_get_cached_doc_raw

1. **docRef lookup** — If `docRef` is provided, reads the exact cache object. If missing, throws an error.
2. **Semantic search** — If no `docRef`, searches the docs index by `libraryId`, `libraryName`, `libraryVersion`, `query`, `topic`, and/or `page`. Filters and intersects candidate pools from multiple indexes.
3. **Ambiguity handling** — If exactly one candidate matches, loads and returns its raw text. If multiple match, returns a list of candidates with their docRefs so the LLM can refine the lookup.

### Cache architecture

The cache lives under `$XDG_CACHE_HOME/pi-context7/` (default `~/.cache/pi-context7/`):

- **Resolve cache** — `cache/resolve/objects/<hash>.json` stores resolve results. `cache/resolve/index/` holds `all.json` and `by-library.json` for fast lookups.
- **Docs cache** — `cache/docs/objects/<hash>.json` stores raw + curated text. `cache/docs/index/` holds `all.json`, `by-ref.json`, `by-library-id.json`, `by-library-name.json`, and `by-version.json` for semantic searches.
- **Atomic writes** — All JSON writes go to a temp file first, then are renamed into place. This prevents corruption if the process crashes mid-write.
- **TTL pruning** — On every read, expired entries are pruned and orphaned object files are deleted. Entries whose object files are missing are also removed from indexes.
- **Mutation queue** — A simple promise-based queue serializes concurrent cache mutations so two simultaneous tool calls don't corrupt the index files.

### Curation algorithm

1. **Keyword extraction** — Extracts 3+ character alphanumeric words from the query and topic, removes stopwords, and keeps up to 12 unique keywords.
2. **Section splitting** — Splits the raw text on markdown headings (`# `) and short capitalized labels (`Foo:`).
3. **Section scoring** — Each section gets a base score of `max(0, 8 - index)`. Keyword occurrences add 4 points each; a keyword in the heading adds 6 points.
4. **Selection** — High-signal sections (score > 8) are picked first, sorted by score. If none are high-signal, the earliest sections are used. Up to 12 sections are selected.
5. **Assembly** — Selected sections are concatenated in original order and wrapped with a metadata header and docRef footer.

## Key Design Decisions

- **No external npm dependencies** — Uses only Node.js built-ins (`crypto`, `fs`, `fs/promises`, `os`, `path`) plus the global `fetch`. Pi transpiles extensions directly.
- **Pi-native, not MCP** — Bypasses the Model Context Protocol entirely. Direct HTTP to Context7 means no extra server process, no stdio pipes, and no MCP client configuration.
- **Persistent searchable cache** — Documentation is cached locally with structured indexes so repeated lookups for the same library are instant. Semantic fields (`libraryName`, `version`, `query`, `topic`, `page`) make it easy to find prior fetches without remembering an exact docRef.
- **Curated by default, raw on demand** — `context7_get_library_docs` returns a compact, keyword-relevant summary to save tokens. If the LLM needs more, it can call `context7_get_cached_doc_raw` for the full text. This two-step pattern avoids flooding the context window with long docs.
- **Stale fallback** — If Context7 is unreachable, stale cached docs are still usable. The tool reports the stale status so the LLM knows the data may be outdated.
- **Auto-resolve with ambiguity guard** — `context7_get_library_docs` can resolve library names automatically, but it refuses to guess when results are ambiguous. This prevents fetching docs for the wrong library.
- **Config via env or JSON** — The API key can be set via `CONTEXT7_API_KEY` (preferred) or in `~/.pi/agent/context7.json`. Cache TTLs are also configurable.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("context7_resolve_library_id")` | Registers the library resolution tool |
| `pi.registerTool("context7_get_library_docs")` | Registers the curated docs fetch tool |
| `pi.registerTool("context7_get_cached_doc_raw")` | Registers the raw cached docs retrieval tool |

## Configuration

### Environment variable (preferred)

```bash
export CONTEXT7_API_KEY=ctx7sk-...
```

The API key is optional — Context7 works without one but with lower rate limits.

### Config file

Create `~/.pi/agent/context7.json`:

```json
{
  "apiKey": "ctx7sk-...",
  "cache": {
    "resolveTtlHours": 168,
    "docsTtlHours": 24
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `apiKey` | — | Context7 API key |
| `cache.resolveTtlHours` | `168` (7 days) | How long to cache library ID resolutions |
| `cache.docsTtlHours` | `24` (1 day) | How long to cached fetched documentation |
