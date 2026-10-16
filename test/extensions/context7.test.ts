import { Check } from "typebox/value";
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
    readdir: vi.fn(() => Promise.resolve([])),
    rm: vi.fn(() => Promise.resolve()),
    // writeJsonAtomic (lib/json-atomic.ts) stages every write through a
    // file handle; this fake handle lets mocked-land puts succeed without
    // a real filesystem.
    open: vi.fn(async () => ({
      writeFile: async () => {},
      sync: async () => {},
      close: async () => {},
    })),
    unlink: vi.fn(() => Promise.resolve()),
    // withFileLock (lib/file-lock.ts) claims lock pathnames with link; this
    // mock lets mocked-land puts acquire their lock without a real filesystem.
    link: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: vi.fn(() => ({
      update: vi.fn(() => ({
        digest: vi.fn(() => "a".repeat(64)),
      })),
    })),
  };
});

// Passthrough spy: tests assert the cache serializes mutations through the
// shared cross-process lock while keeping the real lock behavior.
vi.mock("../../lib/file-lock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/file-lock.ts")>();
  return {
    ...actual,
    withFileLock: vi.fn(actual.withFileLock),
  };
});

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withFileLock } from "../../lib/file-lock.ts";

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

// Renders through a registered tool's renderResult with an identity theme,
// so assertions check the plain visible text of the rendered lines.
function renderResultLines(
  tool: { renderResult?: unknown },
  result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  context: Record<string, unknown>,
): string[] {
  const theme = { fg: (_color: string, text: string) => text };
  const render = tool.renderResult as
    | ((...args: unknown[]) => { render: (width: number) => string[] })
    | undefined;
  if (!render) throw new Error("Tool has no renderResult");
  return render(result, options, theme, context).render(80);
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

const CACHE_DIR = "/home/test/.cache/pi-context7";

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

// Delegates the mocked fs modules to the real implementations against a
// fresh temp root, so tests can assert what actually landed on disk. The
// mocked homedir points into the root, so cache and agent dirs are isolated.
async function setupRealFsCacheRoot() {
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const actualFsSync = await vi.importActual<typeof import("node:fs")>("node:fs");
  const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
  const actualCrypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  const root = await actualFs.mkdtemp(join(actualOs.tmpdir(), "pi-context7-test-"));

  vi.mocked(mkdir).mockImplementation(actualFs.mkdir);
  vi.mocked(writeFile).mockImplementation(actualFs.writeFile);
  vi.mocked(rename).mockImplementation(actualFs.rename);
  vi.mocked(readFile).mockImplementation(actualFs.readFile);
  vi.mocked(readdir).mockImplementation(actualFs.readdir);
  vi.mocked(rm).mockImplementation(actualFs.rm);
  vi.mocked(open).mockImplementation(actualFs.open);
  vi.mocked(unlink).mockImplementation(actualFs.unlink);
  vi.mocked(link).mockImplementation(actualFs.link);
  vi.mocked(existsSync).mockImplementation(actualFsSync.existsSync);
  vi.mocked(createHash).mockImplementation(actualCrypto.createHash);
  vi.mocked(homedir).mockReturnValue(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));

  return { root, cachePath: join(root, ".cache", "pi-context7"), actualFs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context7-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    // The host shell may set XDG_CACHE_HOME; pin it so the cache root is the
    // mocked home's ~/.cache regardless of where tests run.
    vi.stubEnv("XDG_CACHE_HOME", "");
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

  describe("prompt guidance", () => {
    async function tool(name: string) {
      const mockPi = createMockPi();
      await context7Extension(mockPi);
      return getRegisteredTool(mockPi, name);
    }

    it("reserves explicit resolution for disambiguation and ID selection", async () => {
      const resolve = await tool("context7_resolve_library_id");
      const text = [resolve.promptSnippet, ...resolve.promptGuidelines].join("\n");
      expect(text).not.toMatch(/before fetching docs/i);
      expect(text).not.toMatch(/do not already know the exact/i);
      expect(text).toMatch(/ambiguous/i);
      expect(text).toMatch(/context7_get_library_docs resolves/i);
    });

    it("keeps name-based docs lookup and curated-first, bounded raw retrieval", async () => {
      const docs = (await tool("context7_get_library_docs")).promptGuidelines.join("\n");
      expect(docs).toMatch(/pass libraryName/);
      expect(docs).toMatch(/use it first/);
      const raw = (await tool("context7_get_cached_doc_raw")).promptGuidelines.join("\n");
      expect(raw).toMatch(/only after context7_get_library_docs/);
      expect(raw).toMatch(/offsetLine = nextOffsetLine/);
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    describe("context7_resolve_library_id", () => {
      it("shows collapsed success line with recommended library and cache note", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
        const lines = renderResultLines(
          tool,
          {
            content: [{ type: "text", text: "results" }],
            details: {
              recommendedLibraryId: "/facebook/react",
              source: "fresh-cache",
              results: [{ id: "/facebook/react", title: "React", description: "" }],
            },
          },
          { expanded: false, isPartial: false },
          { args: { libraryName: "react" } },
        );
        expect(lines[0]).toContain('📚 Resolve: "react" → /facebook/react (cached)');
      });

      it("shows collapsed count labels for empty, counted, and ambiguous results", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");

        const noMatches = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: {} },
          { expanded: false, isPartial: false },
          { args: { libraryName: "react" } },
        );
        expect(noMatches[0]).toContain('📚 Resolve: "react" no matches');

        const counted = renderResultLines(
          tool,
          {
            content: [{ type: "text", text: "" }],
            details: {
              results: [
                { id: "/a", title: "A", description: "" },
                { id: "/b", title: "B", description: "" },
              ],
            },
          },
          { expanded: false, isPartial: false },
          { args: { libraryName: "react" } },
        );
        expect(counted[0]).toContain('📚 Resolve: "react" 2 candidates');

        const ambiguous = renderResultLines(
          tool,
          {
            content: [{ type: "text", text: "" }],
            details: {
              ambiguous: true,
              results: [
                { id: "/a", title: "A", description: "" },
                { id: "/b", title: "B", description: "" },
              ],
            },
          },
          { expanded: false, isPartial: false },
          { args: { libraryName: "react" } },
        );
        expect(ambiguous[0]).toContain('📚 Resolve: "react" ambiguous (2 candidates)');
      });

      it("shows collapsed error line with the error text", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "Context7 rate limit hit" }], details: {} },
          { expanded: false, isPartial: false },
          { args: { libraryName: "react" }, isError: true },
        );
        expect(lines[0]).toContain('✗ Resolve: "react" — Context7 rate limit hit');
      });

      it("shows streaming line when partial", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: {} },
          { expanded: false, isPartial: true },
          { args: { libraryName: "react" } },
        );
        expect(lines[0]).toContain('📚 Resolving: "react"...');
      });

      it("shows expanded result preview with snippet metadata and overflow note", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");
        const results = Array.from({ length: 7 }, (_, i) => ({
          id: `/lib/react-${i + 1}`,
          title: `React ${i + 1}`,
          description: "",
          totalSnippets: 5,
          benchmarkScore: 9.1,
        }));
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: { results } },
          { expanded: true, isPartial: false },
          { args: { libraryName: "react" } },
        );
        expect(
          lines.some((line) => line.includes("• React 1 — /lib/react-1 (5 snippets, score 9.1)")),
        ).toBe(true);
        expect(lines.some((line) => line.includes("... and 2 more"))).toBe(true);
      });
    });

    describe("context7_get_library_docs", () => {
      it("shows collapsed success line with query and cache note", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "docs" }], details: { cacheStatus: "fresh" } },
          { expanded: false, isPartial: false },
          { args: { libraryId: "/vercel/next.js", query: "routing" } },
        );
        expect(lines[0]).toContain("📖 Docs: /vercel/next.js — routing (cached)");
      });

      it("shows collapsed error line with the error text", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "Context7 unavailable" }], details: {} },
          { expanded: false, isPartial: false },
          { args: { libraryId: "/vercel/next.js" }, isError: true },
        );
        expect(lines[0]).toContain("✗ Docs: /vercel/next.js — Context7 unavailable");
      });

      it("shows streaming line when partial", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: {} },
          { expanded: false, isPartial: true },
          { args: { libraryId: "/vercel/next.js" } },
        );
        expect(lines[0]).toContain("📖 Fetching docs: /vercel/next.js...");
      });

      it("shows needs-resolution line with query", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: { needsResolution: true } },
          { expanded: false, isPartial: false },
          { args: { libraryName: "next.js", query: "caching" } },
        );
        expect(lines[0]).toContain("📖 Docs: next.js — caching — needs resolution");
      });

      it("shows expanded preview lines and overflow note", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_library_docs");
        const text = Array.from({ length: 12 }, (_, i) => `doc line ${i + 1}`).join("\n");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text }], details: {} },
          { expanded: true, isPartial: false },
          { args: { libraryId: "/vercel/next.js" } },
        );
        expect(lines[0]).toContain("doc line 1");
        expect(lines.some((line) => line.includes("... and 2 more lines"))).toBe(true);
      });
    });

    describe("context7_get_cached_doc_raw", () => {
      it("shows collapsed success line with docRef, cache status, and range", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
        const lines = renderResultLines(
          tool,
          {
            content: [{ type: "text", text: "raw" }],
            details: {
              docRef: "ctx7:docs:abc",
              libraryName: "TestLib",
              cacheStatus: "fresh",
              startLine: 41,
              endLine: 80,
              totalLines: 200,
            },
          },
          { expanded: false, isPartial: false },
          { args: {} },
        );
        expect(lines[0]).toContain("📄 Raw: TestLib — ctx7:docs:abc (fresh) — lines 41-80 of 200");
      });

      it("shows collapsed error line with the error text", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "cache miss" }], details: {} },
          { expanded: false, isPartial: false },
          { args: { docRef: "ctx7:docs:abc" }, isError: true },
        );
        expect(lines[0]).toContain("✗ Raw: ctx7:docs:abc — cache miss");
      });

      it("shows streaming line when partial", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text: "" }], details: {} },
          { expanded: false, isPartial: true },
          { args: {} },
        );
        expect(lines[0]).toContain("📄 Loading raw docs...");
      });

      it("shows ambiguous line with candidate count", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
        const lines = renderResultLines(
          tool,
          {
            content: [{ type: "text", text: "" }],
            details: { ambiguous: true, candidates: [1, 2, 3], libraryName: "TestLib" },
          },
          { expanded: false, isPartial: false },
          { args: {} },
        );
        expect(lines[0]).toContain("📄 Raw: TestLib — ambiguous (3)");
      });

      it("shows expanded preview lines and overflow note", async () => {
        const mockPi = createMockPi();
        await context7Extension(mockPi);
        const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");
        const text = Array.from({ length: 12 }, (_, i) => `raw line ${i + 1}`).join("\n");
        const lines = renderResultLines(
          tool,
          { content: [{ type: "text", text }], details: {} },
          { expanded: true, isPartial: false },
          { args: {} },
        );
        expect(lines[0]).toContain("raw line 1");
        expect(lines.some((line) => line.includes("... and 2 more lines"))).toBe(true);
      });
    });
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
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ text: result.content[0].text, ...result.details });
      expect(result.isError).toBeUndefined();
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
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ text: result.content[0].text, ...result.details });
      expect(result.isError).toBeUndefined();
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
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ text: result.content[0].text, ...result.details });
      expect(result.isError).toBe(true);
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
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ text: result.content[0].text, ...result.details });
      expect(result.isError).toBeUndefined();
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
      expect(tool.outputSchema).toBeDefined();
      expect(Check(tool.outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual({ text: result.content[0].text, ...result.details });
      expect(result.isError).toBe(true);
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

  // --- Cache durability (real filesystem) ---

  describe("cache durability", () => {
    it("writes cache index files even when the parent directory does not exist", async () => {
      const { cachePath, actualFs } = await setupRealFsCacheRoot();

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_get_cached_doc_raw");

      // Fresh cache: docs/index does not exist yet. The semantic lookup's
      // prune-refresh must still land its index write on disk.
      await expect(
        tool.execute("id-1", { libraryName: "NonExistent" }, undefined, undefined, {}),
      ).rejects.toThrow("No cached Context7 documents matched");

      const allIndex = JSON.parse(
        await actualFs.readFile(join(cachePath, "docs", "index", "all.json"), "utf8"),
      );
      expect(allIndex).toEqual([]);
      const byRef = JSON.parse(
        await actualFs.readFile(join(cachePath, "docs", "index", "by-ref.json"), "utf8"),
      );
      expect(byRef).toEqual({});
    });

    it("keeps both instances' writes when two sessions put concurrently", async () => {
      const { cachePath, actualFs } = await setupRealFsCacheRoot();

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const tool = getRegisteredTool(mockPi, "context7_resolve_library_id");

      mockFetchResolve([{ id: "/org/alpha", title: "Alpha", description: "Lib A" }]);
      mockFetchResolve([{ id: "/org/beta", title: "Beta", description: "Lib B" }]);

      // Two Pi instances share the cache directory. Both puts are in flight
      // at once; neither instance's entry may be dropped from the index.
      await Promise.all([
        tool.execute("id-1", { libraryName: "alpha" }, undefined, undefined, {}),
        tool.execute("id-2", { libraryName: "beta" }, undefined, undefined, {}),
      ]);

      const allIndex = JSON.parse(
        await actualFs.readFile(join(cachePath, "resolve", "index", "all.json"), "utf8"),
      ) as Array<{ cacheKey: string; objectKey: string }>;
      expect(allIndex.map((entry) => entry.cacheKey).sort()).toEqual([
        "alpha::alpha",
        "beta::beta",
      ]);
      for (const entry of allIndex) {
        const stats = await actualFs.stat(
          join(cachePath, "resolve", "objects", `${entry.objectKey}.json`),
        );
        expect(stats.isFile()).toBe(true);
      }
    });

    it("serializes puts through the cross-process file lock", async () => {
      const { cachePath, actualFs } = await setupRealFsCacheRoot();

      const mockPi = createMockPi();
      await context7Extension(mockPi);
      const resolveTool = getRegisteredTool(mockPi, "context7_resolve_library_id");
      const docsTool = getRegisteredTool(mockPi, "context7_get_library_docs");

      mockFetchResolve([{ id: "/test/lib", title: "TestLib", description: "Test library" }]);
      await resolveTool.execute("id-1", { libraryName: "testlib" }, undefined, undefined, {});

      mockFetchDocs("# API Docs\n\nDetails here.");
      await docsTool.execute(
        "id-2",
        { libraryId: "/test/lib", query: "overview" },
        undefined,
        undefined,
        {},
      );

      const lockPaths = vi.mocked(withFileLock).mock.calls.map((call) => call[0]);
      expect(lockPaths).toContain(join(cachePath, "resolve", ".all.lock"));
      expect(lockPaths).toContain(join(cachePath, "docs", ".all.lock"));

      // The writes the locks guarded actually landed.
      await actualFs.access(join(cachePath, "resolve", "index", "all.json"));
      await actualFs.access(join(cachePath, "docs", "index", "all.json"));
    });
  });
});
