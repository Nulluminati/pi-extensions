import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import codeSearchExtension from "../../extensions/code-search/code-search.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("code-search-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/code-search");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["code-search.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(6);
    });
  });

  // --- Registration ---

  it("registers the code_search tool", async () => {
    const mockPi = createMockPi();
    await codeSearchExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(1);

    const names = mockPi.registerTool.mock.calls.map(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (call: any[]) => (call[0] as { name: string }).name,
    );
    expect(names).toContain("code_search");
  });

  it("code_search has correct label and description", async () => {
    const mockPi = createMockPi();
    await codeSearchExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "code_search");
    expect(tool.label).toBe("Sourcegraph Code Search");
    expect(tool.description).toContain("public GitHub");
  });

  // --- code_search ---

  describe("code_search", () => {
    it("searches and returns formatted results", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({
              repository: "github.com/vercel/next.js",
              path: "packages/next/src/server/next.ts",
              lineMatches: [{ line: "export function NextServer()", lineNumber: 10 }],
            }),
          ]),
          sseEvent("filters", [
            { value: "lang:typescript", label: "TypeScript", count: 1, kind: "lang" },
          ]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "NextServer" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("vercel/next.js");
      expect(result.content[0].text).toContain("packages/next/src/server/next.ts");
      expect(result.content[0].text).toContain("export function NextServer()");
      expect(result.content[0].text).toContain("TypeScript");
      expect(result.details.totalResults).toBe(1);
      expect(result.details.repositoriesFound).toBe(1);
    });

    it("groups multiple results by repository", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({ repository: "github.com/owner/repo-a", path: "a.ts" }),
            createMatch({ repository: "github.com/owner/repo-b", path: "b.ts" }),
            createMatch({ repository: "github.com/owner/repo-a", path: "c.ts" }),
          ]),
          sseEvent("progress", { done: true, matchCount: 3, repositoriesCount: 2 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "function" }, undefined, undefined, {});

      expect(result.details.repositoriesFound).toBe(2);
      const repoA = result.details.results.find(
        (r: { repository: string; files: unknown[] }) => r.repository === "owner/repo-a",
      );
      expect(repoA?.files).toHaveLength(2);
    });

    it("strips github.com prefix from repository names", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({ repository: "github.com/mui/material-ui", path: "src/useId.ts" }),
          ]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "useId" }, undefined, undefined, {});

      expect(result.details.results[0].repository).toBe("mui/material-ui");
      expect(result.content[0].text).not.toContain("github.com/mui/material-ui (");
    });

    it("applies language, repo, and path filters", async () => {
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      await tool.execute(
        "id-1",
        { query: "foo", language: "typescript", repo: "vercel/next.js", path: "src/" },
        undefined,
        undefined,
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(mockFetch.mock.calls[0]?.[0] ?? ""));
      const q = url.searchParams.get("q") ?? "";
      expect(q).toContain("context:global");
      expect(q).toContain("foo");
      expect(q).toContain("lang:typescript");
      expect(q).toContain("repo:^github\\.com/vercel/next\\.js$");
      expect(q).toContain("file:src/");
      expect(q).toContain("count:10");
      expect(q).toContain("timeout:15s");
      expect(url.searchParams.get("display")).toBe("10");
    });

    it("escapes regex metacharacters in the repo filter", async () => {
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      await tool.execute(
        "id-1",
        { query: "foo", repo: "vercel/next.js" },
        undefined,
        undefined,
        {},
      );

      const url = new URL(String(mockFetch.mock.calls[0]?.[0] ?? ""));
      expect(url.searchParams.get("q")).toContain("repo:^github\\.com/vercel/next\\.js$");
    });

    it("returns error when query is empty", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("query is required");
      expect(result.details.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns error when query is too long", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute(
        "id-1",
        { query: "a".repeat(1001) },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("too long");
      expect(result.details.isError).toBe(true);
    });

    it("returns error for invalid repo format", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute(
        "id-1",
        { query: "foo", repo: "invalid-repo-format" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("owner/repo");
      expect(result.details.isError).toBe(true);
    });

    it("clamps max_results to 50 in the request and defaults to 10", async () => {
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");

      await tool.execute("id-1", { query: "foo", max_results: 100 }, undefined, undefined, {});
      let url = new URL(String(mockFetch.mock.calls[0]?.[0] ?? ""));
      expect(url.searchParams.get("q")).toContain("count:50");
      expect(url.searchParams.get("display")).toBe("50");

      mockFetch.mockClear();
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));
      await tool.execute("id-1", { query: "foo", max_results: -5 }, undefined, undefined, {});
      url = new URL(String(mockFetch.mock.calls[0]?.[0] ?? ""));
      expect(url.searchParams.get("q")).toContain("count:10");
      expect(url.searchParams.get("display")).toBe("10");
    });

    it("returns 'no results' message for empty matches", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("progress", { done: true, matchCount: 0 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute(
        "id-1",
        { query: "xyz-nonexistent" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("No code results found");
      expect(result.details.totalResults).toBe(0);
    });

    it("surfaces stream error events as tool errors", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("error", { message: "invalid pattern: unclosed group" }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "(unclosed" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("invalid pattern");
      expect(result.details.isError).toBe(true);
    });

    it("handles HTTP rate limit errors with an actionable message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve("Too Many Requests"),
      });

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("429");
      expect(result.content[0].text).toContain("wait");
      expect(result.details.isError).toBe(true);
    });

    it("handles HTTP server errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("Internal Server Error"),
      });

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("500");
      expect(result.details.isError).toBe(true);
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("Connection refused");
      expect(result.details.isError).toBe(true);
    });

    it("reports a readable message when the request aborts", async () => {
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("timed out or was cancelled");
      expect(result.details.isError).toBe(true);
    });

    it("handles invalid response payloads", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("event: matches\ndata: not-json\n\n"),
      });

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("invalid response");
      expect(result.details.isError).toBe(true);
    });

    it("calls onUpdate while searching", async () => {
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const onUpdate = vi.fn();
      await tool.execute("id-1", { query: "foo" }, undefined, onUpdate, {});

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: expect.stringContaining("Searching") }],
          details: expect.objectContaining({ query: "foo" }),
        }),
      );
    });

    it("sends Sourcegraph stream headers", async () => {
      mockFetch.mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers["User-Agent"]).toContain("pi-code-search");
      expect(init.headers.Accept).toBe("text/event-stream");
    });

    it("uses line numbers and line text from lineMatches", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({
              path: "src/example.ts",
              lineMatches: [
                { line: "const a = 1;", lineNumber: 10 },
                { line: "const b = 2;", lineNumber: 20 },
              ],
            }),
          ]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "const" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("lines 10, 20");
      expect(result.content[0].text).toContain("const a = 1;");
      expect(result.content[0].text).toContain("const b = 2;");
    });

    it("uses the language reported by the API for fenced snippets", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({ path: "main.py", language: "Python" }),
            createMatch({ path: "main.rs", language: "Rust" }),
          ]),
          sseEvent("progress", { done: true, matchCount: 2, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.details.results[0].files[0].language).toBe("python");
      expect(result.details.results[0].files[1].language).toBe("rust");
      expect(result.content[0].text).toContain("```python");
      expect(result.content[0].text).toContain("```rust");
    });

    it("falls back to a short commit sha when branch is empty", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [createMatch({ branches: [""], commit: "48c6663a66b7" })]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.details.results[0].files[0].branch).toBe("48c6663");
    });

    it("limits long snippets", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [
            createMatch({
              path: "a.ts",
              lineMatches: Array.from({ length: 12 }, (_, i) => ({
                line: `line ${i} ${"x".repeat(60)}`,
                lineNumber: i + 1,
              })),
            }),
          ]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("...");
    });

    it("limits result count to max_results", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent(
            "matches",
            Array.from({ length: 20 }, (_, i) => createMatch({ path: `file${i}.ts` })),
          ),
          sseEvent("progress", { done: true, matchCount: 20, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute(
        "id-1",
        { query: "foo", max_results: 5 },
        undefined,
        undefined,
        {},
      );

      expect(result.details.resultsShown).toBe(5);
    });

    it("extracts language and repository facets from filter events", async () => {
      mockFetch.mockResolvedValueOnce(
        createStreamResponse([
          sseEvent("matches", [createMatch({ path: "a.ts" })]),
          sseEvent("filters", [
            { value: "lang:typescript", label: "TypeScript", count: 3, kind: "lang" },
            {
              value: "repo:^github\\.com/owner/repo$",
              label: "github.com/owner/repo",
              count: 1,
              kind: "repo",
            },
          ]),
          sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
          sseEvent("done", {}),
        ]),
      );

      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.details.topLanguages).toEqual([{ val: "TypeScript", count: 3 }]);
      expect(result.details.topRepositories).toEqual([{ val: "owner/repo", count: 1 }]);
    });

    // --- result cache ---

    describe("result cache", () => {
      it("serves identical repeat queries from cache without refetching", async () => {
        mockFetch.mockResolvedValueOnce(
          createStreamResponse([
            sseEvent("matches", [createMatch({ path: "a.ts" })]),
            sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
            sseEvent("done", {}),
          ]),
        );

        const mockPi = createMockPi();
        await codeSearchExtension(mockPi);
        const tool = getRegisteredTool(mockPi, "code_search");

        const first = await tool.execute("id-1", { query: "cached" }, undefined, undefined, {});
        const second = await tool.execute("id-2", { query: "cached" }, undefined, undefined, {});

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(second.content[0].text).toBe(first.content[0].text);
      });

      it("does not cache across separate extension instances", async () => {
        mockFetch.mockResolvedValue(
          createStreamResponse([
            sseEvent("matches", [createMatch({ path: "a.ts" })]),
            sseEvent("progress", { done: true, matchCount: 1, repositoriesCount: 1 }),
            sseEvent("done", {}),
          ]),
        );

        const piOne = createMockPi();
        await codeSearchExtension(piOne);
        const piTwo = createMockPi();
        await codeSearchExtension(piTwo);

        const toolOne = getRegisteredTool(piOne, "code_search");
        const toolTwo = getRegisteredTool(piTwo, "code_search");
        await toolOne.execute("id-1", { query: "fresh" }, undefined, undefined, {});
        await toolTwo.execute("id-2", { query: "fresh" }, undefined, undefined, {});

        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it("does not cache errors so retries can succeed", async () => {
        mockFetch
          .mockRejectedValueOnce(new Error("Connection refused"))
          .mockResolvedValueOnce(createStreamResponse([sseEvent("done", {})]));

        const mockPi = createMockPi();
        await codeSearchExtension(mockPi);
        const tool = getRegisteredTool(mockPi, "code_search");

        const failed = await tool.execute("id-1", { query: "retry-me" }, undefined, undefined, {});
        expect(failed.details.isError).toBe(true);

        const retried = await tool.execute("id-2", { query: "retry-me" }, undefined, undefined, {});
        expect(retried.details.isError).toBeFalsy();
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    it("shows compact success line with result count", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "results" }],
        details: {
          query: "test query",
          totalResults: 42,
          resultsShown: 10,
          repositoriesFound: 3,
          topLanguages: [],
          topRepositories: [],
          results: [],
        },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, { args: { query: "test query" } });
      const lines = component.render(80);
      expect(lines[0]).toContain("test query");
      expect(lines[0]).toContain("42 matches");
      expect(lines[0]).toContain("3 repos");
    });

    it("shows 'no results' when count is 0", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "No code results found" }],
        details: {
          query: "test",
          totalResults: 0,
          resultsShown: 0,
          repositoriesFound: 0,
          topLanguages: [],
          topRepositories: [],
          results: [],
        },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, { args: { query: "test" } });
      const lines = component.render(80);
      expect(lines[0]).toContain("no results");
    });

    it("shows compact error line", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Error: Sourcegraph rate limit" }],
        details: {
          query: "test",
          totalResults: 0,
          resultsShown: 0,
          repositoriesFound: 0,
          topLanguages: [],
          topRepositories: [],
          results: [],
          isError: true,
        },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: false }, theme, {
        args: { query: "test" },
        isError: true,
      });
      const lines = component.render(80);
      expect(lines[0]).toContain("test");
      expect(lines[0]).toContain("Error");
    });

    it("shows loading state when isPartial", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Searching..." }],
        details: { query: "test query" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: true }, theme, { args: { query: "test query" } });
      const lines = component.render(80);
      expect(lines[0]).toContain("Code search:");
      expect(lines[0]).toContain("test query");
      expect(lines[0]).toContain("...");
    });

    it("shows limited repository preview when expanded", async () => {
      const mockPi = createMockPi();
      await codeSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "code_search");
      const theme = { fg: (_c: string, text: string) => text, dim: (text: string) => text };
      const result = {
        content: [{ type: "text", text: "results" }],
        details: {
          query: "test",
          totalResults: 10,
          resultsShown: 7,
          repositoriesFound: 7,
          topLanguages: [],
          topRepositories: [],
          results: Array.from({ length: 7 }, (_, i) => ({
            repository: `owner/repo-${i + 1}`,
            matchesCount: i + 1,
            files: Array.from({ length: i + 1 }, () => ({})),
          })),
        },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: true, isPartial: false }, theme, { args: { query: "test" } });
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("owner/repo-1"))).toBe(true);
      expect(lines.some((l: string) => l.includes("owner/repo-5"))).toBe(true);
      expect(lines.some((l: string) => l.includes("owner/repo-6"))).toBe(false);
      expect(lines.some((l: string) => l.includes("... and 2 more repositories"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getRegisteredTool(mockPi: Record<string, unknown>, name: string): any {
  const calls = (mockPi as { registerTool: { mock: { calls: Array<[Record<string, unknown>]> } } })
    .registerTool.mock.calls;
  for (const call of calls) {
    if ((call[0] as { name: string }).name === name) return call[0];
  }
  throw new Error(`Tool "${name}" not found`);
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createStreamResponse(events: string[]) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(events.join("")),
  };
}

function createMatch(overrides: Record<string, unknown> = {}) {
  return {
    type: "content",
    path: "src/main.ts",
    repositoryID: 1,
    repository: "github.com/owner/repo",
    repoStars: 100,
    branches: ["main"],
    commit: "48c6663a66b7eacbd9c7c411863ab5d18dbeea88",
    lineMatches: [{ line: 'console.log("hello")', lineNumber: 1, offsetAndLengths: [[0, 7]] }],
    language: "TypeScript",
    ...overrides,
  };
}
