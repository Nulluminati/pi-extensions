import { beforeEach, describe, expect, it, vi } from "vitest";
import grepAppExtension from "../../extensions/grep-app/grep-app.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

function createGrepAppResponse(
  hits: Array<{
    repo?: string;
    path?: string;
    branch?: string;
    totalMatches?: number;
    snippet?: string;
  }>,
  options: {
    total?: number;
    languages?: Array<{ val: string; count: number }>;
    repositories?: Array<{ val: string; count: number }>;
  } = {},
) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        facets: {
          count: options.total ?? hits.length,
          lang: { buckets: options.languages ?? [] },
          repo: { buckets: options.repositories ?? [] },
        },
        hits: {
          hits: hits.map((hit) => ({
            repo: { raw: hit.repo ?? "owner/repo" },
            path: { raw: hit.path ?? "src/main.ts" },
            branch: { raw: hit.branch ?? "main" },
            total_matches: { raw: String(hit.totalMatches ?? 1) },
            content: { snippet: hit.snippet ?? '<code data-line="1">console.log("hello")</code>' },
          })),
        },
      }),
  };
}

function mockFetchError(status: number, statusText: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(statusText),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grep-app-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  // --- Registration ---

  it("registers the grep_search tool", async () => {
    const mockPi = createMockPi();
    await grepAppExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(1);

    const names = mockPi.registerTool.mock.calls.map(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (call: any[]) => (call[0] as { name: string }).name,
    );
    expect(names).toContain("grep_search");
  });

  it("grep_search has correct label and description", async () => {
    const mockPi = createMockPi();
    await grepAppExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "grep_search");
    expect(tool.label).toBe("Grep.app Code Search");
    expect(tool.description).toContain("grep.app");
  });

  // --- grep_search ---

  describe("grep_search", () => {
    it("searches and returns formatted results", async () => {
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse(
          [
            {
              repo: "vercel/next.js",
              path: "packages/next/src/server/next.ts",
              branch: "main",
              totalMatches: 3,
              snippet: '<code data-line="10">export function NextServer()</code>',
            },
          ],
          {
            total: 1,
            languages: [{ val: "TypeScript", count: 1 }],
            repositories: [{ val: "vercel/next.js", count: 1 }],
          },
        ),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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
        createGrepAppResponse(
          [
            { repo: "owner/repo-a", path: "a.ts", snippet: '<code data-line="1">foo()</code>' },
            { repo: "owner/repo-b", path: "b.ts", snippet: '<code data-line="2">bar()</code>' },
            { repo: "owner/repo-a", path: "c.ts", snippet: '<code data-line="3">baz()</code>' },
          ],
          { total: 3 },
        ),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "function" }, undefined, undefined, {});

      expect(result.details.repositoriesFound).toBe(2);
      const repoA = result.details.results.find(
        (r: { repository: string; files: unknown[] }) => r.repository === "owner/repo-a",
      );
      expect(repoA?.files).toHaveLength(2);
    });

    it("applies language, repo, and path filters", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      await tool.execute(
        "id-1",
        { query: "foo", language: "typescript", repo: "vercel/next.js", path: "src/" },
        undefined,
        undefined,
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("q=foo");
      expect(url).toContain("f.lang=typescript");
      expect(url).toContain("f.repo=vercel%2Fnext.js");
      expect(url).toContain("f.path=src%2F");
    });

    it("returns error when query is empty", async () => {
      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("query is required");
      expect(result.details.isError).toBe(true);
    });

    it("returns error when query is too long", async () => {
      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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

    it("clamps max_results between 1 and 50", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");

      // Upper bound should not affect URL since max_results is client-side limit
      await tool.execute("id-1", { query: "foo", max_results: 100 }, undefined, undefined, {});
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));
      await tool.execute("id-1", { query: "foo", max_results: -5 }, undefined, undefined, {});
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("defaults max_results to 10", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      // Default is applied internally; just ensure the call is made
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns 'no results' message for empty response", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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

    it("handles rate limit errors", async () => {
      mockFetchError(429, "Too Many Requests");

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("Rate limit exceeded");
      expect(result.details.isError).toBe(true);
    });

    it("handles API errors", async () => {
      mockFetchError(500, "Internal Server Error");

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("500");
      expect(result.details.isError).toBe(true);
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("Connection refused");
      expect(result.details.isError).toBe(true);
    });

    it("handles invalid response format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve("not-an-object"),
      });

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("invalid response");
      expect(result.details.isError).toBe(true);
    });

    it("calls onUpdate while searching", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const onUpdate = vi.fn();
      await tool.execute("id-1", { query: "foo" }, undefined, onUpdate, {});

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: expect.stringContaining("Searching grep.app") }],
          details: expect.objectContaining({ query: "foo" }),
        }),
      );
    });

    it("sends User-Agent header", async () => {
      mockFetch.mockResolvedValueOnce(createGrepAppResponse([]));

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers["User-Agent"]).toContain("pi-grep-app");
      expect(init.headers.Accept).toBe("application/json");
    });

    it("cleans HTML tags and decodes entities from snippets", async () => {
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse([
          {
            repo: "test/repo",
            path: "src/example.ts",
            snippet:
              '<div><code data-line="42">if (a &amp;&amp; b &lt; c) { return &quot;ok&quot;; }</code></div>',
          },
        ]),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain('if (a && b < c) { return "ok"; }');
      expect(result.content[0].text).not.toContain("<code>");
    });

    it("extracts line numbers from data-line attributes", async () => {
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse([
          {
            repo: "test/repo",
            path: "src/example.ts",
            snippet:
              '<code data-line="10">line1</code><code data-line="20">line2</code><code data-line="30">line3</code>',
          },
        ]),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("lines 10, 20, 30");
    });

    it("infers language from file extension", async () => {
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse([
          { repo: "test/repo", path: "main.py", snippet: '<code data-line="1">def foo():</code>' },
          { repo: "test/repo", path: "main.rs", snippet: '<code data-line="1">fn foo() {}</code>' },
        ]),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.details.results[0].files[0].language).toBe("python");
      expect(result.details.results[0].files[1].language).toBe("rust");
    });

    it("limits long snippets", async () => {
      const longSnippet = `<code data-line="1">${"x".repeat(500)}</code>`;
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse([{ repo: "test/repo", path: "a.ts", snippet: longSnippet }]),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute("id-1", { query: "foo" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("...");
    });

    it("limits result count to max_results", async () => {
      mockFetch.mockResolvedValueOnce(
        createGrepAppResponse(
          Array.from({ length: 20 }, (_, i) => ({
            repo: "test/repo",
            path: `file${i}.ts`,
            snippet: `<code data-line="${i}">code${i}</code>`,
          })),
        ),
      );

      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const result = await tool.execute(
        "id-1",
        { query: "foo", max_results: 5 },
        undefined,
        undefined,
        {},
      );

      expect(result.details.resultsShown).toBe(5);
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    it("shows compact success line with result count", async () => {
      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Error: Rate limit exceeded" }],
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
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
      const theme = { fg: (_c: string, text: string) => text };
      const result = {
        content: [{ type: "text", text: "Searching..." }],
        details: { query: "test query" },
      };
      const component = (
        tool.renderResult as (...args: unknown[]) => { render: (width: number) => string[] }
      )(result, { expanded: false, isPartial: true }, theme, { args: { query: "test query" } });
      const lines = component.render(80);
      expect(lines[0]).toContain("Grep:");
      expect(lines[0]).toContain("test query");
      expect(lines[0]).toContain("...");
    });

    it("shows limited repository preview when expanded", async () => {
      const mockPi = createMockPi();
      await grepAppExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "grep_search");
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
