import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import context7Extension, { type DocCacheIndexEntry } from "../../extensions/context7/context7.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Mock node modules
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  readdir: vi.fn(() => Promise.resolve([])),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

vi.mock("node:crypto", () => ({
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => "a".repeat(64)),
    })),
  })),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getRegisteredTool(mockPi: Record<string, unknown>, name: string): any {
  const calls = (mockPi as Record<string, { mock: { calls: unknown[][] } }>).registerTool.mock
    .calls;
  for (const call of calls) {
    const tool = call[0] as { name: string } | undefined;
    if (tool?.name === name) return call[0];
  }
  throw new Error(`Tool "${name}" not found`);
}

function mockFetchResolve(
  results: Array<{
    id: string;
    title: string;
    description: string;
    totalSnippets?: number;
    trustScore?: number;
    benchmarkScore?: number;
    versions?: string[];
    source?: string;
  }>,
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ results }),
    text: () => Promise.resolve(JSON.stringify({ results })),
  });
}

function mockFetchDocs(text: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
  });
}

function mockFetchError(status: number, message: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(message),
  });
}

function mockFetchInvalidJson() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve("not-an-object"),
    text: () => Promise.resolve("not-an-object"),
  });
}

const CACHE_DIR = "/home/test/.pi/agent/extensions/context7/cache";

function setupFreshResolveCache(
  libraryName: string,
  query: string,
  results: Array<{ id: string; title: string; description: string }>,
) {
  const objectKey = "a".repeat(24);
  const objectPath = `${CACHE_DIR}/resolve/objects/${objectKey}.json`;

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(existsSync).mockImplementation((p: any) => p === objectPath);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(readFile).mockImplementation((p: any) => {
    if (p === objectPath) {
      return Promise.resolve(
        JSON.stringify({
          kind: "resolve",
          cacheKey: `${libraryName.toLowerCase().trim()}::${query.toLowerCase().trim()}`,
          objectKey,
          libraryName,
          normalizedLibraryName: libraryName.toLowerCase(),
          query,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
          results,
        }),
      );
    }
    throw new Error("ENOENT");
  });
}

function setupFreshDocsCache(docRef: string, rawText: string, curatedText: string) {
  const objectKey = "a".repeat(24);
  const objectPath = `${CACHE_DIR}/docs/objects/${objectKey}.json`;

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(existsSync).mockImplementation((p: any) => p === objectPath);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(readFile).mockImplementation((p: any) => {
    if (p === objectPath) {
      return Promise.resolve(
        JSON.stringify({
          kind: "docs",
          docRef,
          objectKey,
          libraryId: "/test/lib",
          libraryName: "TestLib",
          normalizedLibraryName: "testlib",
          query: "overview",
          effectiveQuery: "overview",
          page: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
          rawText,
          curatedText,
        }),
      );
    }
    throw new Error("ENOENT");
  });
}

function setupDocsIndexCache(candidates: Array<Partial<DocCacheIndexEntry>>) {
  const allIndexPath = `${CACHE_DIR}/docs/index/all.json`;

  const fullEntries = candidates.map((c, i) => ({
    kind: "docs" as const,
    docRef: c.docRef ?? `ctx7:docs:ref${i}`,
    objectKey: "a".repeat(24),
    libraryId: c.libraryId ?? "/test/lib",
    libraryName: c.libraryName ?? "TestLib",
    normalizedLibraryName: normalizeText(c.libraryName ?? "testlib"),
    libraryVersion: c.libraryVersion,
    libraryVersionRaw: c.libraryVersion,
    query: c.query ?? "overview",
    topic: c.topic,
    effectiveQuery: c.effectiveQuery ?? "overview",
    page: c.page ?? 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
    rawLength: 100,
    curatedLength: 80,
    ...c,
  }));

  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(existsSync).mockImplementation((p: any) => p === allIndexPath);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(readFile).mockImplementation((p: any) => {
    if (p === allIndexPath) return Promise.resolve(JSON.stringify(fullEntries));
    throw new Error("ENOENT");
  });
}

function normalizeText(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context7-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const { readdir: readActualDirectory } =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const extensionDir = resolve(import.meta.dirname, "../../extensions/context7");
      const rootEntries = await readActualDirectory(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readActualDirectory(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["context7.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(10);
    });
  });

  // --- Registration ---

  it("registers all three context7 tools", async () => {
    const mockPi = createMockPi();
    await context7Extension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(3);

    const names = mockPi.registerTool.mock.calls.map(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (call: any[]) => (call[0] as { name: string }).name,
    );
    expect(names).toContain("context7_resolve_library_id");
    expect(names).toContain("context7_get_library_docs");
    expect(names).toContain("context7_get_cached_doc_raw");
  });

  it("resolve tool has correct label and description", async () => {
    const mockPi = createMockPi();
    await context7Extension(mockPi);
    const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
    expect(tool.label).toBe("Context7 Resolve Library ID");
    expect(tool.description).toContain("Context7");
  });

  it("docs tool has correct label and description", async () => {
    const mockPi = createMockPi();
    await context7Extension(mockPi);
    const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
    expect(tool.label).toBe("Context7 Get Library Docs");
    expect(tool.description).toContain("curated");
  });

  it("raw docs tool has correct label and description", async () => {
    const mockPi = createMockPi();
    await context7Extension(mockPi);
    const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
    expect(tool.label).toBe("Context7 Get Cached Raw Doc");
    expect(tool.description).toContain("raw cached");
  });

  // --- context7_resolve_library_id ---

  describe("context7_resolve_library_id", () => {
    it("resolves library via network and returns candidates", async () => {
      mockFetchResolve([{ id: "/facebook/react", title: "React", description: "A JS library" }]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const result = await tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("React");
      expect(result.content[0].text).toContain("/facebook/react");
      expect(result.content[0].text).toContain(
        "Recommended library ID: /facebook/react\n- Title: React",
      );
      expect(result.details.source).toBe("network");
      expect(result.details.recommendedLibraryId).toBe("/facebook/react");
      expect(result.details.ambiguous).toBe(false);
    });

    it("returns fresh cache hit without network call", async () => {
      setupFreshResolveCache("react", "react", [
        { id: "/facebook/react", title: "React", description: "Cached" },
      ]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const result = await tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {});

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("React");
      expect(result.details.source).toBe("fresh-cache");
    });

    it("throws when network fails and no cache exists", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await expect(
        tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {}),
      ).rejects.toThrow("Unable to reach Context7");
    });

    it("flags ambiguous results when multiple libraries match", async () => {
      mockFetchResolve([
        {
          id: "/org/react-lite",
          title: "react-lite",
          description: "React clone",
          benchmarkScore: 5,
          trustScore: 5,
        },
        {
          id: "/facebook/react-dom",
          title: "react-dom",
          description: "Official React",
          benchmarkScore: 5,
          trustScore: 5,
        },
      ]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const result = await tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("ambiguous");
      expect(result.details.ambiguous).toBe(true);
      expect(result.details.recommendedLibraryId).toBeUndefined();
    });

    it("selects exact match unambiguously", async () => {
      mockFetchResolve([
        {
          id: "/org/react",
          title: "react-lite",
          description: "Lightweight",
          benchmarkScore: 5,
          trustScore: 5,
        },
        {
          id: "/facebook/react",
          title: "react",
          description: "Official",
          benchmarkScore: 10,
          trustScore: 10,
        },
      ]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const result = await tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {});

      expect(result.details.ambiguous).toBe(false);
      expect(result.details.recommendedLibraryId).toBe("/facebook/react");
    });

    it("handles empty results", async () => {
      mockFetchResolve([]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const result = await tool.execute(
        "id-1",
        { libraryName: "xyz-unknown" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("No Context7 libraries matched");
      expect(result.details.recommendedLibraryId).toBeUndefined();
    });

    it("handles rate limit errors", async () => {
      mockFetchError(429, "Rate limited");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await expect(
        tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {}),
      ).rejects.toThrow("rate limit");
    });

    it("handles auth errors", async () => {
      mockFetchError(401, "Unauthorized");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await expect(
        tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {}),
      ).rejects.toThrow("invalid");
    });

    it("handles invalid response format", async () => {
      mockFetchInvalidJson();

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await expect(
        tool.execute("id-1", { libraryName: "react" }, undefined, undefined, {}),
      ).rejects.toThrow("invalid search response");
    });

    it("uses optional query parameter for resolution", async () => {
      mockFetchResolve([{ id: "/test/lib", title: "Lib", description: "Test lib" }]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await tool.execute(
        "id-1",
        { libraryName: "lib", query: "how to use" },
        undefined,
        undefined,
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("query=how+to+use");
      expect(url).toContain("libraryName=lib");
    });

    it("sends X-Context7-Source header", async () => {
      mockFetchResolve([{ id: "/test/lib", title: "Lib", description: "Test" }]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      await tool.execute("id-1", { libraryName: "lib" }, undefined, undefined, {});

      const init = mockFetch.mock.calls[0]?.[1];
      expect(init.headers["X-Context7-Source"]).toBe("pi-extension");
    });
  });

  // --- context7_get_library_docs ---

  describe("context7_get_library_docs", () => {
    it("fetches docs by libraryId directly", async () => {
      mockFetchDocs("# API Docs\n\nThis is the documentation.\n\n## Section 1\nDetails here.");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryId: "/test/lib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("API Docs");
      expect(result.content[0].text).toContain("Relevant documentation:\n\n# API Docs");
      expect(result.details.libraryId).toBe("/test/lib");
      expect(result.details.cacheStatus).toBe("refreshed");
      expect(result.details.curation).toBeDefined();
    });

    it("auto-resolves libraryName before fetching docs", async () => {
      mockFetchResolve([{ id: "/test/lib", title: "TestLib", description: "Test library" }]);
      mockFetchDocs("# TestLib Docs\n\nContent here.");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryName: "testlib", query: "overview" },
        undefined,
        undefined,
        {},
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toContain("TestLib");
      expect(result.details.libraryId).toBe("/test/lib");
      expect(result.details.resolve).toBeDefined();
    });

    it("returns resolution candidates when ambiguous", async () => {
      mockFetchResolve([
        { id: "/org/lib-alpha", title: "lib-alpha", description: "Lib A" },
        { id: "/other/lib-beta", title: "lib-beta", description: "Lib B" },
      ]);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute("id-1", { libraryName: "lib" }, undefined, undefined, {});

      expect(result.content[0].text).toContain("Unable to safely auto-resolve");
      expect(result.details.needsResolution).toBe(true);
    });

    it("returns fresh cache hit", async () => {
      setupFreshDocsCache(
        "ctx7:docs:ref1",
        "# Raw\n\nFull docs here.",
        "# Curated\n\nSelected content.",
      );

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryId: "/test/lib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("Selected content");
      expect(result.details.cacheStatus).toBe("fresh");
    });

    it("falls back to stale cache on network failure", async () => {
      const objectPath = `${CACHE_DIR}/docs/objects/${"a".repeat(24)}.json`;

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(existsSync).mockImplementation((p: any) => p === objectPath);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(readFile).mockImplementation((p: any) => {
        if (p === objectPath) {
          return Promise.resolve(
            JSON.stringify({
              kind: "docs",
              docRef: "ctx7:docs:stale1",
              objectKey: "a".repeat(24),
              libraryId: "/test/lib",
              libraryName: "TestLib",
              normalizedLibraryName: "testlib",
              query: "overview",
              effectiveQuery: "overview",
              page: 1,
              createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
              expiresAt: new Date(Date.now() - 1000).toISOString(),
              rawText: "Stale raw docs",
              curatedText: "Stale curated docs",
            }),
          );
        }
        throw new Error("ENOENT");
      });
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryId: "/test/lib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Stale curated docs");
      expect(result.content[0].text).toContain("stale cached docs");
      expect(result.details.cacheStatus).toBe("stale");
    });

    it("throws when neither libraryId nor libraryName provided", async () => {
      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      await expect(tool.execute("id-1", {}, undefined, undefined, {})).rejects.toThrow(
        "requires either libraryId or libraryName",
      );
    });

    it("curates long docs by selecting relevant sections", async () => {
      const longDoc = Array.from(
        { length: 50 },
        (_, i) => `# Section ${i + 1}\n\nContent for section ${i + 1} goes here with some details.`,
      ).join("\n\n");
      mockFetchDocs(longDoc);

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryId: "/test/lib", query: "section 1" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Section 1");
      expect(result.details.curation.truncated).toBe(true);
      expect(result.details.curation.selectedSectionCount).toBeGreaterThan(0);
    });

    it("handles empty doc response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("   "),
      });

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      await expect(
        tool.execute("id-1", { libraryId: "/test/lib" }, undefined, undefined, {}),
      ).rejects.toThrow("empty documentation response");
    });

    it("handles page parameter correctly", async () => {
      mockFetchDocs("Page 2 content");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      const result = await tool.execute(
        "id-1",
        { libraryId: "/test/lib", page: 2 },
        undefined,
        undefined,
        {},
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("page");
      expect(result.details.page).toBe(2);
    });

    it("uses topic in effective query", async () => {
      mockFetchDocs("Topic content");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
      await tool.execute(
        "id-1",
        { libraryId: "/test/lib", query: "how to", topic: "authentication" },
        undefined,
        undefined,
        {},
      );

      const url = String(mockFetch.mock.calls[0]?.[0] ?? "");
      expect(decodeURIComponent(url)).toContain("authentication");
    });
  });

  // --- context7_get_cached_doc_raw ---

  describe("context7_get_cached_doc_raw", () => {
    it("returns raw docs by docRef", async () => {
      setupFreshDocsCache(
        "ctx7:docs:ref1",
        "# Raw Documentation\n\nFull uncurated content here.",
        "# Curated\n\nShort version.",
      );

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { docRef: "ctx7:docs:ref1" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toBe("# Raw Documentation\n\nFull uncurated content here.");
      expect(result.details.docRef).toBe("ctx7:docs:ref1");
      expect(result.details.cacheStatus).toBe("fresh");
      expect(result.details.truncated).toBe(false);
    });

    it("caps documents over 2000 lines and reports the next offset", async () => {
      const bigRaw = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
      setupFreshDocsCache("ctx7:docs:big", bigRaw, "curated");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { docRef: "ctx7:docs:big" },
        undefined,
        undefined,
        {},
      );

      const text = result.content[0].text as string;
      expect(text).toContain("lines 1-2000 of 2500");
      expect(text).toContain("offsetLine=2001");
      expect(text).toContain("line 1");
      expect(text).toContain("line 2000");
      expect(text).not.toContain("line 2001");
      expect(text.length).toBeLessThan(45_000);
      expect(result.details.truncated).toBe(true);
      expect(result.details.totalLines).toBe(2500);
      expect(result.details.nextOffsetLine).toBe(2001);
      expect(result.details.startLine).toBe(1);
      expect(result.details.endLine).toBe(2000);
    });

    it("pages from offsetLine and reports end-of-document without a footer", async () => {
      const bigRaw = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
      setupFreshDocsCache("ctx7:docs:big", bigRaw, "curated");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { docRef: "ctx7:docs:big", offsetLine: 2001 },
        undefined,
        undefined,
        {},
      );

      const text = result.content[0].text as string;
      expect(text).toContain("lines 2001-2500 of 2500");
      expect(text).toContain("line 2500");
      expect(text).not.toContain("offsetLine=");
      expect(result.details.truncated).toBe(false);
      expect(result.details.nextOffsetLine).toBeUndefined();
      expect(result.details.startLine).toBe(2001);
      expect(result.details.endLine).toBe(2500);
    });

    it("rejects offsetLine beyond the end of the document", async () => {
      setupFreshDocsCache("ctx7:docs:ref1", "short doc", "curated");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      await expect(
        tool.execute(
          "id-1",
          { docRef: "ctx7:docs:ref1", offsetLine: 999 },
          undefined,
          undefined,
          {},
        ),
      ).rejects.toThrow(/beyond the end/);
    });

    it("caps a single oversized line by character budget", async () => {
      const hugeRaw = `${"A".repeat(100_000)}\ntail`;
      setupFreshDocsCache("ctx7:docs:huge", hugeRaw, "curated");

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { docRef: "ctx7:docs:huge" },
        undefined,
        undefined,
        {},
      );

      const text = result.content[0].text as string;
      expect(text).toContain("lines 1-1 of 2");
      expect(text.length).toBeLessThan(41_000);
      expect(result.details.truncated).toBe(true);
      expect(result.details.nextOffsetLine).toBe(2);
    });

    it("throws when docRef not found", async () => {
      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      await expect(
        tool.execute("id-1", { docRef: "ctx7:docs:missing" }, undefined, undefined, {}),
      ).rejects.toThrow("No cached Context7 document found");
    });

    it("finds single match by semantic lookup", async () => {
      setupDocsIndexCache([
        {
          docRef: "ctx7:docs:match1",
          libraryName: "TestLib",
          libraryId: "/test/lib",
          query: "overview",
        },
      ]);

      const objectPath = `${CACHE_DIR}/docs/objects/${"a".repeat(24)}.json`;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(existsSync).mockImplementation((p: any) => {
        return p.includes("docs/index/all.json") || p === objectPath;
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(readFile).mockImplementation((p: any) => {
        if (p === objectPath) {
          return Promise.resolve(
            JSON.stringify({
              kind: "docs",
              docRef: "ctx7:docs:match1",
              objectKey: "a".repeat(24),
              libraryId: "/test/lib",
              libraryName: "TestLib",
              normalizedLibraryName: "testlib",
              query: "overview",
              effectiveQuery: "overview",
              page: 1,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
              rawText: "Semantic match raw content",
              curatedText: "Curated",
            }),
          );
        }
        if (p.includes("docs/index/all.json")) {
          return Promise.resolve(
            JSON.stringify([
              {
                kind: "docs",
                docRef: "ctx7:docs:match1",
                objectKey: "a".repeat(24),
                libraryId: "/test/lib",
                libraryName: "TestLib",
                normalizedLibraryName: "testlib",
                query: "overview",
                effectiveQuery: "overview",
                page: 1,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
                rawLength: 100,
                curatedLength: 80,
              },
            ]),
          );
        }
        throw new Error("ENOENT");
      });

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { libraryName: "TestLib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toBe("Semantic match raw content");
      expect(result.details.ambiguous).toBeUndefined();
    });

    it("returns ambiguous candidates for multiple matches", async () => {
      const allIndexPath = `${CACHE_DIR}/docs/index/all.json`;
      const objectPath = `${CACHE_DIR}/docs/objects/${"a".repeat(24)}.json`;

      vi.mocked(existsSync).mockImplementation(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        ((p: any) => p === allIndexPath || p === objectPath) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(readFile).mockImplementation((p: any) => {
        if (p === objectPath) {
          return Promise.resolve(
            JSON.stringify({
              kind: "docs",
              docRef: "ctx7:docs:match1",
              objectKey: "a".repeat(24),
              libraryId: "/test/lib",
              libraryName: "TestLib",
              normalizedLibraryName: "testlib",
              query: "overview",
              effectiveQuery: "overview",
              page: 1,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
              rawText: "Match 1 raw content",
              curatedText: "Curated 1",
            }),
          );
        }
        if (p === allIndexPath) {
          return Promise.resolve(
            JSON.stringify([
              {
                kind: "docs",
                docRef: "ctx7:docs:match1",
                objectKey: "a".repeat(24),
                libraryId: "/test/lib",
                libraryName: "TestLib",
                normalizedLibraryName: "testlib",
                query: "overview",
                effectiveQuery: "overview",
                page: 1,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
                rawLength: 100,
                curatedLength: 80,
              },
              {
                kind: "docs",
                docRef: "ctx7:docs:match2",
                objectKey: "a".repeat(24),
                libraryId: "/test/lib",
                libraryName: "TestLib",
                normalizedLibraryName: "testlib",
                query: "overview",
                effectiveQuery: "overview",
                page: 1,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
                rawLength: 100,
                curatedLength: 80,
              },
            ]),
          );
        }
        throw new Error("ENOENT");
      });

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { libraryName: "TestLib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toContain("Multiple cached Context7 documents matched");
      expect(result.details.ambiguous).toBe(true);
      expect(result.details.candidates).toHaveLength(2);
    });

    it("throws when no semantic matches found", async () => {
      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      await expect(
        tool.execute("id-1", { libraryName: "NonExistent" }, undefined, undefined, {}),
      ).rejects.toThrow("No cached Context7 documents matched");
    });

    it("throws when no selectors provided", async () => {
      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      await expect(tool.execute("id-1", {}, undefined, undefined, {})).rejects.toThrow(
        "requires docRef or semantic lookup fields",
      );
    });

    it("handles stale cache by docRef", async () => {
      const objectPath = `${CACHE_DIR}/docs/objects/${"a".repeat(24)}.json`;

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(existsSync).mockImplementation((p: any) => p === objectPath);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(readFile).mockImplementation((p: any) => {
        if (p === objectPath) {
          return Promise.resolve(
            JSON.stringify({
              kind: "docs",
              docRef: "ctx7:docs:stale",
              objectKey: "a".repeat(24),
              libraryId: "/test/lib",
              libraryName: "TestLib",
              normalizedLibraryName: "testlib",
              query: "overview",
              effectiveQuery: "overview",
              page: 1,
              createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
              expiresAt: new Date(Date.now() - 1000).toISOString(),
              rawText: "Stale raw content",
              curatedText: "Curated",
            }),
          );
        }
        throw new Error("ENOENT");
      });

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
      const result = await tool.execute(
        "id-1",
        { docRef: "ctx7:docs:stale" },
        undefined,
        undefined,
        {},
      );

      expect(result.content[0].text).toBe("Stale raw content");
      expect(result.details.cacheStatus).toBe("stale");
    });
  });
});
