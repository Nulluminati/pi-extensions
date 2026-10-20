import { resolve } from "node:path";
import { Check } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHtmlEntities } from "../../extensions/web-search/src/html.ts";
import webSearchExtension from "../../extensions/web-search/web-search.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { mockFn } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { fakeTui, getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(() => Promise.resolve("/tmp/pi-web-search-abc123")),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THEME = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getRegisteredTool(mockPi: Record<string, unknown>, name: string): any {
  const calls = (mockPi as { registerTool: { mock: { calls: unknown[][] } } }).registerTool.mock
    .calls;
  for (const call of calls) {
    if ((call[0] as { name: string }).name === name) return call[0];
  }
  throw new Error(`Tool "${name}" not found`);
}

function braveSearchResponse(
  results: Array<{ title?: string; url?: string; description?: string }>,
) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        web: { results },
      }),
  };
}

function syntheticSearchResponse(
  results: Array<{ title?: string; url?: string; text?: string; published?: string }>,
) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ results }),
  };
}

function searxngSearchResponse(results: Array<{ title?: string; url?: string; content?: string }>) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        query: "q",
        number_of_results: results.length,
        results,
      }),
  };
}

function fetchResponse(
  body: string,
  options: {
    contentType?: string;
    contentLength?: number;
    ok?: boolean;
    status?: number;
    statusText?: string;
  } = {},
) {
  const headers = new Map<string, string>();
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.contentLength !== undefined)
    headers.set("content-length", String(options.contentLength));

  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    text: () => Promise.resolve(body),
  };
}

/** Configure a ctx whose synthetic key resolves through modelRegistry. */
function withSyntheticKey(
  mockCtx: ReturnType<typeof createMockCommandContext>,
  key: string | undefined,
) {
  mockCtx.modelRegistry.getApiKeyForProvider = vi.fn(() => Promise.resolve(key));
  return mockCtx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web-search-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const { readdir: readActualDirectory } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const extensionDir = resolve(import.meta.dirname, "../../extensions/web-search");
      const rootEntries = await readActualDirectory(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readActualDirectory(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["web-search.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(8);
    });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("SYNTHETIC_API_KEY", "");
  });

  // --- Registration ---

  it("registers web_search and web_fetch tools", async () => {
    const mockPi = createMockPi();
    await webSearchExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(2);

    const names = mockPi.registerTool.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  it("registers /websearch:select command and session lifecycle hooks", async () => {
    const mockPi = createMockPi();
    await webSearchExtension(mockPi);

    const commands = mockPi.registerCommand.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(commands).toContain("websearch:select");

    const events = mockPi.on.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(events).toEqual(["session_start"]);
  });

  it("web_search description mentions configurable providers and /websearch:select", async () => {
    const mockPi = createMockPi();
    await webSearchExtension(mockPi);
    const tool = getRegisteredTool(mockPi, "web_search");
    expect(tool.description).toContain("configured search provider");
    expect(tool.description).toContain("/websearch:select");
  });

  describe("prompt guidance", () => {
    async function guidelines(name: string): Promise<string> {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      return (getRegisteredTool(mockPi, name).promptGuidelines as string[]).join("\n");
    }

    it("web_search targets current external information and source discovery", async () => {
      const text = await guidelines("web_search");
      expect(text).toMatch(/current/i);
      expect(text).toMatch(/discover|find sources/i);
      expect(text).toMatch(/cite sources/i);
    });

    it("web_fetch reads supplied or known URLs directly without a prior search", async () => {
      const text = await guidelines("web_fetch");
      expect(text).not.toMatch(/web_search first/i);
      expect(text).toMatch(/supplie[sd]/i);
      expect(text).toMatch(/directly/i);
      expect(text).toContain("raw=true");
    });
  });

  // --- web_search via brave (default provider) ---

  describe("web_search via brave", () => {
    async function setupWithBraveActive() {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      // Brave is no longer the default provider; activate it explicitly so
      // these tests target the brave backend regardless of the configured default.
      await getCommandHandler(mockPi, "websearch:select")("brave", createMockCommandContext());
      return { mockPi, tool: getRegisteredTool(mockPi, "web_search") };
    }

    it.each(["success", "empty", "missing-query", "unconfigured", "network-error"])(
      "returns schema-backed data for %s without changing text",
      async (scenario) => {
        if (scenario !== "unconfigured") vi.stubEnv("BRAVE_API_KEY", "test-key");
        const results =
          scenario === "success"
            ? [{ title: "Title", url: "https://example.com", description: "Snippet" }]
            : [];
        if (scenario === "network-error") mockFetch.mockRejectedValue(new Error("offline"));
        else mockFetch.mockResolvedValue(braveSearchResponse(results));
        const { tool } = await setupWithBraveActive();
        const query = scenario === "missing-query" ? "" : "test";
        const result = await tool.execute("data", { query }, undefined, undefined, {});
        const failed = ["missing-query", "unconfigured", "network-error"].includes(scenario);
        expect(tool.outputSchema).toBeDefined();
        expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
        expect(result.structuredContent).toEqual({
          query,
          backend: "brave",
          resultCount: results.length,
          results: results.map(({ title, url, description }) => ({
            title,
            url,
            snippet: description,
          })),
          ...(failed ? { error: result.content[0].text } : {}),
        });
        expect(result.isError).toBe(failed ? true : undefined);
        expect(result.terminate).toBeUndefined();
        if (scenario === "success") {
          expect(result.content).toEqual([
            { type: "text", text: "**Title**\nhttps://example.com\nSnippet" },
          ]);
        } else if (scenario === "empty") {
          expect(result.content).toEqual([{ type: "text", text: "No results found for: test" }]);
        } else if (scenario === "missing-query") {
          expect(result.content).toEqual([{ type: "text", text: "Error: query is required" }]);
        } else {
          expect(result.content[0].text).toMatch(/^Error: /);
          expect(result.content[0].text).toContain(
            scenario === "unconfigured" ? "BRAVE_API_KEY" : "offline",
          );
        }
      },
    );

    it("returns error when BRAVE_API_KEY is not set", async () => {
      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});
      expect(result.content[0].text).toContain("BRAVE_API_KEY");
      expect(result.details.resultCount).toBe(0);
      expect(result.details.backend).toBe("brave");
      expect(result.details.isError).toBe(true);
    });

    it("auth error mentions the /websearch:select switch", async () => {
      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});
      expect(result.content[0].text).toContain("/websearch:select");
    });

    it("returns error when query is empty", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "" }, undefined, undefined, {});
      expect(result.content[0].text).toContain("query is required");
    });

    it("searches and returns formatted results", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(
        braveSearchResponse([
          { title: "Result 1", url: "https://example.com/1", description: "Description 1" },
          { title: "Result 2", url: "https://example.com/2", description: "Description 2" },
        ]),
      );

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test query" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("**Result 1**");
      expect(result.content[0].text).toContain("https://example.com/1");
      expect(result.content[0].text).toContain("Description 1");
      expect(result.details.query).toBe("test query");
      expect(result.details.backend).toBe("brave");
      expect(result.details.resultCount).toBe(2);
      expect(result.details.results).toHaveLength(2);
    });

    it("sends correct headers to Brave API", async () => {
      vi.stubEnv("BRAVE_API_KEY", "my-secret-key");
      mockFetch.mockResolvedValue(braveSearchResponse([]));

      const { tool } = await setupWithBraveActive();
      await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs?.[0];
      const init = callArgs?.[1];
      expect(url).toContain("api.search.brave.com");
      expect(url).toContain("q=test");
      expect(init.headers["X-Subscription-Token"]).toBe("my-secret-key");
      expect(init.headers.Accept).toBe("application/json");
    });

    it("clamps max_results between 1 and 10", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(braveSearchResponse([]));

      const { tool } = await setupWithBraveActive();

      await tool.execute("id-1", { query: "test", max_results: 50 }, undefined, undefined, {});
      let calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(calledUrl).toContain("count=10");

      mockFetch.mockClear();

      await tool.execute("id-2", { query: "test", max_results: -5 }, undefined, undefined, {});
      calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(calledUrl).toContain("count=1");
    });

    it("defaults max_results to 5", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(braveSearchResponse([]));

      const { tool } = await setupWithBraveActive();
      await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      const calledUrl = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(calledUrl).toContain("count=5");
    });

    it("calls onUpdate while searching", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(braveSearchResponse([]));

      const { tool } = await setupWithBraveActive();
      const onUpdate = vi.fn();
      await tool.execute("id-1", { query: "test" }, undefined, onUpdate, {});

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: expect.stringContaining("Searching Brave Search for:") }],
          details: expect.objectContaining({ query: "test", backend: "brave" }),
        }),
      );
    });

    it("returns 'no results' message for empty response", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(braveSearchResponse([]));

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "obscure" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("No results found");
    });

    it("handles missing web.results gracefully", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("No results found");
      expect(result.details.resultCount).toBe(0);
    });

    it("handles API errors", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      });

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("429");
      expect(result.details.resultCount).toBe(0);
    });

    it("handles network errors", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockRejectedValue(new Error("Network failure"));

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("Network failure");
    });

    it("handles null/missing fields in Brave results", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(
        braveSearchResponse([{} as { title?: string; url?: string; description?: string }]),
      );

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(result.details.results[0].title).toBe("");
      expect(result.details.results[0].url).toBe("");
      expect(result.details.results[0].snippet).toBe("");
    });

    it("decodes HTML entities and strips tags in Brave titles and snippets", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(
        braveSearchResponse([
          {
            // Mirrors the real Brave payload: hex numeric entities (&#x27;),
            // named entities (&amp;), and stray emphasis tags (<strong>).
            title: "Tom &amp; Jerry&#x27;s <strong>show</strong>",
            url: "https://example.com/1",
            description: "It&#x27;s a &quot;great&quot; show &lt;3 &#65; <strong>now</strong>",
          },
        ]),
      );

      const { tool } = await setupWithBraveActive();
      const result = await tool.execute("id-1", { query: "test" }, undefined, undefined, {});

      expect(result.details.results[0].title).toBe("Tom & Jerry's show");
      expect(result.details.results[0].snippet).toBe('It\'s a "great" show <3 A now');
      // Cleaned text also flows into the formatted output the LLM sees.
      expect(result.content[0].text).toContain("Tom & Jerry's show");
      expect(result.content[0].text).toContain('It\'s a "great" show <3 A now');
      expect(result.content[0].text).not.toContain("&#x27;");
      expect(result.content[0].text).not.toContain("<strong>");
    });
  });

  // --- web_search via synthetic ---

  describe("web_search via synthetic", () => {
    async function setupWithSyntheticActive() {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-secret-key");

      // Switch active provider to synthetic via the command path.
      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("synthetic", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      return { mockPi, mockCtx, tool };
    }

    it("is configured when modelRegistry resolves a synthetic key", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      mockFetch.mockResolvedValue(syntheticSearchResponse([]));

      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer syn-secret-key");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({ query: "docs" });
    });

    it("also resolves the synthetic key from SYNTHETIC_API_KEY env", async () => {
      vi.stubEnv("SYNTHETIC_API_KEY", "env-syn-key");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      // No modelRegistry key, so env should be used.
      const mockCtx = createMockCommandContext();
      mockCtx.modelRegistry.getApiKeyForProvider = vi.fn(() => Promise.resolve(undefined));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("synthetic", mockCtx);

      mockFetch.mockResolvedValue(syntheticSearchResponse([]));
      const tool = getRegisteredTool(mockPi, "web_search");
      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers.Authorization).toBe("Bearer env-syn-key");
    });

    it("formats synthetic results with title, url, and snippet", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      mockFetch.mockResolvedValue(
        syntheticSearchResponse([
          {
            title: "curl Docs",
            url: "https://curl.se/docs/projdocs.html",
            text: "Project documentation for curl.",
            published: "2025-11-05T00:00:00.000Z",
          },
        ]),
      );

      const result = await tool.execute("id-1", { query: "curl" }, undefined, undefined, mockCtx);

      expect(result.details.backend).toBe("synthetic");
      expect(result.details.resultCount).toBe(1);
      expect(result.content[0].text).toContain("**curl Docs**");
      expect(result.content[0].text).toContain("https://curl.se/docs/projdocs.html");
      // Publish date is prefixed onto the snippet.
      expect(result.content[0].text).toContain("2025-11-05");
      expect(result.content[0].text).toContain("Project documentation for curl.");
    });

    it("caps long synthetic text excerpts with an ellipsis", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      const longText = "x".repeat(1000);
      mockFetch.mockResolvedValue(
        syntheticSearchResponse([{ title: "T", url: "https://x.io", text: longText }]),
      );

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.details.results[0].snippet.endsWith("…")).toBe(true);
      expect(result.details.results[0].snippet.length).toBeLessThan(longText.length);
    });

    it("slices results to max_results", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      mockFetch.mockResolvedValue(
        syntheticSearchResponse(
          Array.from({ length: 12 }, (_, i) => ({
            title: `R${i}`,
            url: `https://x.io/${i}`,
            text: "t",
          })),
        ),
      );

      const result = await tool.execute(
        "id-1",
        { query: "q", max_results: 3 },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details.resultCount).toBe(3);
    });

    it("returns auth error when synthetic key is missing", async () => {
      vi.stubEnv("SYNTHETIC_API_KEY", "");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockCtx.modelRegistry.getApiKeyForProvider = vi.fn(() => Promise.resolve(undefined));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("synthetic", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.details.isError).toBe(true);
      expect(result.content[0].text).toContain("Synthetic");
      expect(result.content[0].text).toContain("/websearch:select");
    });

    it("handles synthetic API errors", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("401");
      expect(result.details.isError).toBe(true);
    });

    it("handles network errors", async () => {
      const { tool, mockCtx } = await setupWithSyntheticActive();
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  // --- web_search via searxng ---

  describe("web_search via searxng", () => {
    async function setupWithSearXngActive() {
      vi.stubEnv("SEARXNG_URL", "http://localhost:8080");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      return { mockPi, mockCtx, tool };
    }

    it("is configured when SEARXNG_URL is set", async () => {
      vi.stubEnv("SEARXNG_URL", "http://localhost:8080");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockFetch.mockResolvedValue(searxngSearchResponse([]));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("http://localhost:8080/search");
      expect(url).toContain("q=docs");
      expect(url).toContain("format=json");
    });

    it("sends GET request with format=json and slices to max_results", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockResolvedValue(
        searxngSearchResponse(
          Array.from({ length: 12 }, (_, i) => ({
            title: `R${i}`,
            url: `https://x.io/${i}`,
            content: `snippet ${i}`,
          })),
        ),
      );

      const result = await tool.execute(
        "id-1",
        { query: "q", max_results: 3 },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.details.backend).toBe("searxng");
      expect(result.details.resultCount).toBe(3);
      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.method).toBe("GET");
    });

    it("normalizes a trailing slash in the instance URL", async () => {
      vi.stubEnv("SEARXNG_URL", "http://localhost:8080/");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockFetch.mockResolvedValue(searxngSearchResponse([]));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(url).not.toContain("//search");
      expect(url).toContain("http://localhost:8080/search");
    });

    it("sends Bearer auth header when SEARXNG_API_KEY is set", async () => {
      vi.stubEnv("SEARXNG_URL", "http://localhost:8080");
      vi.stubEnv("SEARXNG_API_KEY", "my-token");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockFetch.mockResolvedValue(searxngSearchResponse([]));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers.Authorization).toBe("Bearer my-token");
    });

    it("does not send Authorization header when no API key is set", async () => {
      vi.stubEnv("SEARXNG_URL", "http://localhost:8080");
      vi.stubEnv("SEARXNG_API_KEY", "");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockFetch.mockResolvedValue(searxngSearchResponse([]));

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers.Authorization).toBeUndefined();
    });

    it("formats searxng results with title, url, and content snippet", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockResolvedValue(
        searxngSearchResponse([
          {
            title: "Example Page",
            url: "https://example.com/page",
            content: "A snippet describing the page.",
          },
        ]),
      );

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("**Example Page**");
      expect(result.content[0].text).toContain("https://example.com/page");
      expect(result.content[0].text).toContain("A snippet describing the page.");
    });

    it("strips tags/decodes entities in searxng snippets", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockResolvedValue(
        searxngSearchResponse([
          {
            title: "Tom &amp; Jerry&#x27;s <b>show</b>",
            url: "https://example.com",
            content: "It&#x27;s &quot;great&quot;",
          },
        ]),
      );

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.details.results[0].title).toBe("Tom & Jerry's show");
      expect(result.details.results[0].snippet).toBe('It\'s "great"');
    });

    it("skips results without a url", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockResolvedValue(
        searxngSearchResponse([
          { title: "No url", content: "c" },
          { title: "Has url", url: "https://example.com", content: "c" },
        ]),
      );

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.details.resultCount).toBe(1);
      expect(result.details.results[0].url).toBe("https://example.com");
    });

    it("returns config error when SEARXNG_URL is not set", async () => {
      vi.stubEnv("SEARXNG_URL", "");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();

      const commandHandler = getCommandHandler(mockPi, "websearch:select");
      await commandHandler("searxng", mockCtx);

      const tool = getRegisteredTool(mockPi, "web_search");
      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.details.isError).toBe(true);
      expect(result.content[0].text).toContain("SEARXNG_URL");
      expect(result.content[0].text).toContain("/websearch:select");
    });

    it("handles searxng API errors (403 when json format disabled)", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("403");
      expect(result.details.isError).toBe(true);
    });

    it("handles network errors", async () => {
      const { tool, mockCtx } = await setupWithSearXngActive();
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const result = await tool.execute("id-1", { query: "q" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  // --- /websearch:select command ---

  describe("/websearch:select command", () => {
    it("/websearch:select <id> sets the active provider and persists it", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("synthetic", mockCtx);

      expect(mockPi.appendEntry).toHaveBeenCalledWith("web-search-provider", {
        provider: "synthetic",
      });
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Synthetic"), "info");
    });

    it("/websearch:select select <id> accepts the select subcommand alias", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("select synthetic", mockCtx);

      expect(mockPi.appendEntry).toHaveBeenCalledWith("web-search-provider", {
        provider: "synthetic",
      });
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Synthetic"), "info");
    });

    it("/websearch:select <id> warns when the provider is not configured", async () => {
      vi.stubEnv("SYNTHETIC_API_KEY", "");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockCtx.modelRegistry.getApiKeyForProvider = vi.fn(() => Promise.resolve(undefined));

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("synthetic", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not configured"),
        "warning",
      );
    });

    it("/websearch:select <unknown> notifies an error and lists available providers", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("google", mockCtx);

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown search provider "google"'),
        "error",
      );
      const notifyCall = mockCtx.ui.notify.mock.calls[0]?.[0] as string;
      expect(notifyCall).toContain("brave");
      expect(notifyCall).toContain("synthetic");
      expect(notifyCall).toContain("searxng");
      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("/websearch:select with no args opens the selector and applies the choice", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");
      vi.stubEnv("BRAVE_API_KEY", "brave-key");

      // Capture the factory so we can also assert the rendered list, and
      // resolve the selection to "synthetic".
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let capturedFactory: ((tui: any, theme: any, kb: any, done: any) => any) | undefined;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockCtx.ui.custom = mockFn((factory: any) => {
        capturedFactory = factory;
        return Promise.resolve("synthetic");
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      }) as any;

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("", mockCtx);

      // Selector listed both providers with their labels.
      const factory = capturedFactory;
      expect(factory).toBeDefined();
      const component = factory?.(fakeTui(), THEME, null, vi.fn());
      const lines = component.render(80) as string[];
      expect(lines.some((l: string) => l.includes("Brave Search"))).toBe(true);
      expect(lines.some((l: string) => l.includes("Synthetic"))).toBe(true);

      // Choice was applied.
      expect(mockPi.appendEntry).toHaveBeenCalledWith("web-search-provider", {
        provider: "synthetic",
      });
    });

    it("selector marks unconfigured providers", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      // Brave configured, synthetic not.
      vi.stubEnv("BRAVE_API_KEY", "brave-key");
      mockCtx.modelRegistry.getApiKeyForProvider = vi.fn(() => Promise.resolve(undefined));

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let capturedFactory: ((tui: any, theme: any, kb: any, done: any) => any) | undefined;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockCtx.ui.custom = mockFn((factory: any) => {
        capturedFactory = factory;
        return Promise.resolve(null);
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      }) as any;

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("", mockCtx);

      const fg = vi.fn((_color: string, text: string) => text);
      const component = capturedFactory?.(fakeTui(), { ...THEME, fg }, null, vi.fn());
      const lines = component.render(80) as string[];
      expect(lines[0]).toContain("╭── Web Search ");
      expect(lines.join("\n")).not.toContain("Select Web Search Provider");
      expect(lines.some((l: string) => l.includes("not configured"))).toBe(true);
      expect(lines.some((l: string) => l.includes("active"))).toBe(false);
      expect(fg).toHaveBeenCalledWith("accent", "Synthetic (not configured)");
    });

    it("selector filters providers by description text", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      vi.stubEnv("BRAVE_API_KEY", "brave-key");
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      let capturedFactory: ((tui: any, theme: any, kb: any, done: any) => any) | undefined;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockCtx.ui.custom = mockFn((factory: any) => {
        capturedFactory = factory;
        return Promise.resolve(null);
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      }) as any;

      await getCommandHandler(mockPi, "websearch:select")("", mockCtx);

      const component = capturedFactory?.(fakeTui(), THEME, { matches: matchesPickerKey }, vi.fn());
      for (const character of "independent") component.handleInput(character);
      const rendered = component.render(80).join("\n");
      expect(rendered).toContain("Brave Search");
      expect(rendered).not.toContain("Synthetic");
    });

    it("uses the standard selector in RPC mode", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockCtx.mode = "rpc";
      mockCtx.ui.select = vi.fn(async (_title, options) => options[1]);

      await getCommandHandler(mockPi, "websearch:select")("", mockCtx);

      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
      expect(mockCtx.ui.select).toHaveBeenCalledWith("Select Web Search Provider", [
        "synthetic",
        "brave",
        "searxng",
      ]);
      expect(mockPi.appendEntry).toHaveBeenCalledWith("web-search-provider", {
        provider: "brave",
      });
    });

    it("/websearch:select with no args cancelled does not change provider", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      mockCtx.ui.custom = mockFn(() => Promise.resolve(null)) as any;

      const handler = getCommandHandler(mockPi, "websearch:select");
      await handler("", mockCtx);

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });
  });

  // --- session_start provider selection ---

  describe("session_start provider selection", () => {
    // The provider is not rendered anywhere in the UI; the observable is the
    // backend recorded in a web_search tool result.
    async function resolvedBackend(
      mockPi: ReturnType<typeof createMockPi>,
      mockCtx: ReturnType<typeof createMockCommandContext>,
    ) {
      const handler = getEventHandler(mockPi, "session_start");
      await handler({ type: "session_start", reason: "resume" }, mockCtx);
      const tool = getRegisteredTool(mockPi, "web_search");
      mockFetch.mockResolvedValue(syntheticSearchResponse([]));
      const result = await tool.execute("id-1", { query: "docs" }, undefined, undefined, mockCtx);
      return result.details.backend;
    }

    it("restores the persisted provider when present", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");
      mockCtx.sessionManager.getBranch = (() => [
        { type: "custom", customType: "web-search-provider", data: { provider: "synthetic" } },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      ]) as any;

      expect(await resolvedBackend(mockPi, mockCtx)).toBe("synthetic");
    });

    it("defaults to synthetic when both brave and synthetic are configured", async () => {
      vi.stubEnv("BRAVE_API_KEY", "brave-key");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");

      expect(await resolvedBackend(mockPi, mockCtx)).toBe("synthetic");
    });

    it("ignores a persisted unknown provider id", async () => {
      vi.stubEnv("BRAVE_API_KEY", "k");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();
      mockCtx.sessionManager.getBranch = (() => [
        { type: "custom", customType: "web-search-provider", data: { provider: "kagi" } },
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      ]) as any;

      // Falls back to the first configured provider since kagi is not registered.
      expect(await resolvedBackend(mockPi, mockCtx)).toBe("brave");
    });

    it("falls back to brave when only brave is configured", async () => {
      vi.stubEnv("BRAVE_API_KEY", "k");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = createMockCommandContext();

      expect(await resolvedBackend(mockPi, mockCtx)).toBe("brave");
    });

    it("falls back to synthetic when brave is unconfigured but synthetic is", async () => {
      vi.stubEnv("BRAVE_API_KEY", "");
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const mockCtx = withSyntheticKey(createMockCommandContext(), "syn-key");

      expect(await resolvedBackend(mockPi, mockCtx)).toBe("synthetic");
    });
  });

  // --- web_fetch (provider-independent) ---

  describe("web_fetch", () => {
    it("returns error when url is empty", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute("id-1", { url: "" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("url is required");
    });

    it("returns error for non-http(s) URLs", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");

      const result = await tool.execute(
        "id-1",
        { url: "ftp://example.com" },
        undefined,
        undefined,
        {},
      );
      expect(result.content[0].text).toContain("Invalid URL protocol");
    });

    it("fetches HTML and converts to text by default", async () => {
      const html =
        "<html><head><title>Test Page</title></head><body><p>Hello world</p></body></html>";
      mockFetch.mockResolvedValue(
        fetchResponse(html, { contentType: "text/html", contentLength: html.length }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Hello world");
      expect(result.content[0].text).toContain("Title: Test Page");
      expect(result.content[0].text).toContain("Content-Type: text/html");
      expect(result.details.title).toBe("Test Page");
      expect(result.details.contentType).toBe("text/html");
    });

    it("returns raw HTML when raw=true", async () => {
      const html = "<html><body><p>Raw content</p></body></html>";
      mockFetch.mockResolvedValue(fetchResponse(html, { contentType: "text/html" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com", raw: true },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("<p>Raw content</p>");
      expect(result.details.title).toBeUndefined();
    });

    it("fetches plain text URLs", async () => {
      mockFetch.mockResolvedValue(
        fetchResponse("Just plain text", { contentType: "text/plain", contentLength: 15 }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/readme.txt" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Just plain text");
      expect(result.content[0].text).toContain("Content-Type: text/plain");
      expect(result.details.contentLength).toBe(15);
    });

    it("rejects binary content types", async () => {
      mockFetch.mockResolvedValue(fetchResponse("binary data", { contentType: "image/png" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/image.png" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Unsupported content type");
    });

    it("rejects video content types", async () => {
      mockFetch.mockResolvedValue(fetchResponse("data", { contentType: "video/mp4" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/vid.mp4" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Unsupported content type");
    });

    it("handles HTTP errors", async () => {
      mockFetch.mockResolvedValue(
        fetchResponse("Not Found", { ok: false, status: 404, statusText: "Not Found" }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/missing" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("HTTP 404");
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Connection refused");
    });

    it("marks network errors as error results", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.details.isError).toBe(true);
    });

    it("strips script and style tags from HTML", async () => {
      const html = `<html><head><style>.x{color:red}</style></head><body><p>Content</p><script>alert('xss')</script></body></html>`;
      mockFetch.mockResolvedValue(fetchResponse(html, { contentType: "text/html" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).not.toContain("alert");
      expect(result.content[0].text).not.toContain("color:red");
      expect(result.content[0].text).toContain("Content");
    });

    it("decodes HTML entities", async () => {
      const html = `<html><body><p>&amp; &lt; &gt; &quot; &#39;</p></body></html>`;
      mockFetch.mockResolvedValue(fetchResponse(html, { contentType: "text/html" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("& < > \" '");
    });

    it("sends User-Agent header", async () => {
      mockFetch.mockResolvedValue(fetchResponse("ok", { contentType: "text/plain" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      await tool.execute("id-1", { url: "https://example.com" }, undefined, undefined, {});

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const init = callArgs?.[1];
      expect(init.headers["User-Agent"]).toContain("pi-web-search");
    });

    it("truncates very large responses and spills to temp file", async () => {
      const largeBody = "x".repeat(60_000);
      mockFetch.mockResolvedValue(
        fetchResponse(largeBody, { contentType: "text/plain", contentLength: 60_000 }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/large" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("truncated");
      expect(result.content[0].text).toContain("Full content saved to:");
      expect(result.details.truncation).toBeDefined();
      expect(result.details.truncation.originalLength).toBe(60_000);
      expect(result.details.fullOutputPath).toBe("/tmp/pi-web-search-abc123/content.txt");
    });

    it("does not truncate small responses", async () => {
      mockFetch.mockResolvedValue(fetchResponse("small", { contentType: "text/plain" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.details.truncation).toBeUndefined();
    });

    it("accepts http:// URLs", async () => {
      mockFetch.mockResolvedValue(fetchResponse("ok", { contentType: "text/plain" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "http://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("ok");
    });

    it("calls onUpdate while fetching", async () => {
      mockFetch.mockResolvedValue(fetchResponse("ok", { contentType: "text/plain" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const onUpdate = vi.fn();
      await tool.execute("id-1", { url: "https://example.com" }, undefined, onUpdate, {});

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: expect.stringContaining("Fetching:") }],
          details: expect.objectContaining({ url: "https://example.com" }),
        }),
      );
    });

    it("handles pages without a title tag", async () => {
      const html = "<html><body><p>No title here</p></body></html>";
      mockFetch.mockResolvedValue(fetchResponse(html, { contentType: "text/html" }));

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).not.toContain("Title:");
      expect(result.details.title).toBeUndefined();
    });

    it("rejects responses with content-length exceeding limit", async () => {
      mockFetch.mockResolvedValue(
        fetchResponse("x".repeat(100), {
          contentType: "text/plain",
          contentLength: 2_000_000,
        }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/large" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("too large");
      expect(result.details.isError).toBe(true);
    });

    it("accepts responses within content-length limit", async () => {
      mockFetch.mockResolvedValue(
        fetchResponse("small", { contentType: "text/plain", contentLength: 500_000 }),
      );

      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = await tool.execute(
        "id-1",
        { url: "https://example.com/medium" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("small");
      expect(result.details.isError).toBeUndefined();
    });
  });

  // --- renderResult ---

  describe("web_fetch renderResult", () => {
    it("shows compact success line with title and size", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = {
        content: [{ type: "text", text: "some body content" }],
        details: { url: "https://example.com", title: "My Page", contentLength: 4096 },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("https://example.com");
      expect(lines[0]).toContain("My Page");
      expect(lines[0]).toContain("4.0KB");
    });

    it("shows compact error line", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = {
        content: [
          { type: "text", text: "Error: HTTP 404 Not Found for https://example.com/missing" },
        ],
        details: { url: "https://example.com/missing", isError: true },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("example.com/missing");
      expect(lines[0]).toContain("Error");
    });

    it("shows loading state when isPartial", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const result = {
        content: [{ type: "text", text: "Loading..." }],
        details: { url: "https://example.com" },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: true }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("Fetching:");
      expect(lines[0]).toContain("example.com");
    });

    it("shows limited preview when expanded", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
      const result = {
        content: [{ type: "text", text: body }],
        details: { url: "https://example.com", title: "My Page", contentLength: 4096 },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: true, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("Line 1"))).toBe(true);
      expect(lines.some((l: string) => l.includes("Line 15"))).toBe(true);
      expect(lines.some((l: string) => l.includes("Line 16"))).toBe(false);
      expect(lines.some((l: string) => l.includes("... and 5 more lines"))).toBe(true);
    });

    it("expanded mentions temp file when truncated", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_fetch");
      const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
      const result = {
        content: [{ type: "text", text: body }],
        details: {
          url: "https://example.com",
          fullOutputPath: "/tmp/pi-web-search-abc123/content.txt",
        },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: true, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("... and 5 more lines"))).toBe(true);
      expect(
        lines.some((l: string) =>
          l.includes("full content at /tmp/pi-web-search-abc123/content.txt"),
        ),
      ).toBe(true);
    });
  });

  describe("web_search renderResult", () => {
    it("shows compact success line with result count", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const result = {
        content: [{ type: "text", text: "**Result 1**\nhttps://example.com" }],
        details: { query: "test query", backend: "brave", resultCount: 3, results: [] },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("test query");
      expect(lines[0]).toContain("3 results");
    });

    it("shows 'no results' when count is 0", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const result = {
        content: [{ type: "text", text: "No results found for: test" }],
        details: { query: "test", backend: "brave", resultCount: 0 },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("no results");
    });

    it("shows compact error line", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const result = {
        content: [{ type: "text", text: "Error: Brave Search API error (429): Rate limited" }],
        details: { query: "test", backend: "brave", resultCount: 0, isError: true },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("test");
      expect(lines[0]).toContain("Error");
    });

    it("truncates long error messages to fit terminal width", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const longError = `Error: Brave Search API error (429): {"type":"ErrorResponse","error":{"id":"702a8864","status":429,"detail":"Request rate limit exceeded for plan"}}`;
      const result = {
        content: [{ type: "text", text: longError }],
        details: {
          query: "@biomejs/biome latest version npm 2025",
          backend: "brave",
          resultCount: 0,
          isError: true,
        },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
      const visibleLen = lines[0].replace(ANSI_RE, "").length;
      expect(visibleLen).toBeLessThanOrEqual(80);
    });

    it("shows loading state when isPartial", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const result = {
        content: [{ type: "text", text: "Searching..." }],
        details: { query: "test query", backend: "brave", resultCount: 0 },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: false, isPartial: true }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines[0]).toContain("Searching:");
      expect(lines[0]).toContain("test query");
    });

    it("shows limited results preview when expanded", async () => {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      const tool = getRegisteredTool(mockPi, "web_search");
      const result = {
        content: [{ type: "text", text: "formatted text" }],
        details: {
          query: "test query",
          backend: "brave",
          resultCount: 7,
          results: Array.from({ length: 7 }, (_, i) => ({
            title: `Result ${i + 1}`,
            url: `https://example.com/${i + 1}`,
            snippet: `Snippet ${i + 1}`,
          })),
        },
      };
      const component = (
        (tool as Record<string, unknown>).renderResult as (...args: unknown[]) => {
          render: (width: number) => string[];
        }
      )(result, { expanded: true, isPartial: false }, THEME, {} as unknown);
      const lines = component.render(80);
      expect(lines.some((l: string) => l.includes("Result 1"))).toBe(true);
      expect(lines.some((l: string) => l.includes("Result 5"))).toBe(true);
      expect(lines.some((l: string) => l.includes("Result 6"))).toBe(false);
      expect(lines.some((l: string) => l.includes("... and 2 more results"))).toBe(true);
    });
  });

  // --- Pi 1.0 tool contract: failures carry a top-level isError flag ---

  describe("top-level isError flag", () => {
    async function setupTools() {
      const mockPi = createMockPi();
      await webSearchExtension(mockPi);
      // Synthetic is the default provider; activate brave so search tests
      // target brave regardless of the configured default.
      await getCommandHandler(mockPi, "websearch:select")("brave", createMockCommandContext());
      return {
        searchTool: getRegisteredTool(mockPi, "web_search"),
        fetchTool: getRegisteredTool(mockPi, "web_fetch"),
      };
    }

    it("flags web_search failures at the top level and in details", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      const { searchTool } = await setupTools();

      const invalid = await searchTool.execute("id-1", { query: "" }, undefined, undefined, {});
      expect(invalid.isError).toBe(true);
      expect(invalid.details.isError).toBe(true);

      mockFetch.mockRejectedValue(new Error("Network failure"));
      const network = await searchTool.execute("id-1", { query: "test" }, undefined, undefined, {});
      expect(network.isError).toBe(true);
      expect(network.details.isError).toBe(true);
    });

    it("does not flag successful web_search results", async () => {
      vi.stubEnv("BRAVE_API_KEY", "test-key");
      mockFetch.mockResolvedValue(
        braveSearchResponse([
          { title: "Result 1", url: "https://example.com/1", description: "Description 1" },
        ]),
      );
      const { searchTool } = await setupTools();
      const result = await searchTool.execute("id-1", { query: "test" }, undefined, undefined, {});
      expect(result.isError).toBeFalsy();
      expect(result.details.isError).toBeFalsy();
    });

    it("flags web_fetch failures at the top level and in details", async () => {
      const { fetchTool } = await setupTools();

      const invalid = await fetchTool.execute(
        "id-1",
        { url: "ftp://example.com" },
        undefined,
        undefined,
        {},
      );
      expect(invalid.isError).toBe(true);
      expect(invalid.details.isError).toBe(true);

      mockFetch.mockRejectedValue(new Error("Connection refused"));
      const network = await fetchTool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );
      expect(network.isError).toBe(true);
      expect(network.details.isError).toBe(true);
    });

    it("does not flag successful web_fetch results", async () => {
      mockFetch.mockResolvedValue(fetchResponse("<p>Hello</p>", { contentType: "text/html" }));
      const { fetchTool } = await setupTools();
      const result = await fetchTool.execute(
        "id-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        {},
      );
      expect(result.isError).toBeFalsy();
      expect(result.details.isError).toBeFalsy();
    });
  });
});

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------

describe("decodeHtmlEntities", () => {
  it("decodes each entity exactly once so double-encoded input stays encoded", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("&amp;gt;")).toBe("&gt;");
    expect(decodeHtmlEntities("&amp;#39;")).toBe("&#39;");
    expect(decodeHtmlEntities("&amp;#x27;")).toBe("&#x27;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("still decodes single-encoded named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("&lt;&#39;&quot;")).toBe("<'\"");
    expect(decodeHtmlEntities("&amp;")).toBe("&");
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
    expect(decodeHtmlEntities("&#x27;Tom&#x27;s &#65;bcd")).toBe("'Tom's Abcd");
  });
});

function matchesPickerKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string> = {
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.select.confirm": "enter",
    "tui.select.cancel": "escape",
  };
  return keys[keybinding] === data;
}
