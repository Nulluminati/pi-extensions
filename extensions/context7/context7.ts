/**
 * Context7 Extension
 *
 * Pi-native Context7 documentation tools. Bypasses MCP entirely — direct HTTP to
 * Context7 API with persistent searchable cache.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "pi";

// --- Constants ---

const CONTEXT7_API_BASE_URL = process.env.CONTEXT7_API_URL || "https://context7.com/api";
const DEFAULT_RESOLVE_TTL_HOURS = 24 * 7;
const DEFAULT_DOCS_TTL_HOURS = 24;
const MAX_CURATED_CHARS = 12_000;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "about",
  "using",
  "use",
  "how",
  "what",
  "when",
  "where",
  "why",
  "are",
  "was",
  "were",
  "can",
  "you",
  "need",
  "docs",
  "doc",
  "library",
  "page",
  "requested",
  "focus",
]);

// --- Types ---

interface Context7ConfigFile {
  apiKey?: string;
  cache?: {
    resolveTtlHours?: number;
    docsTtlHours?: number;
  };
}

interface Context7Settings {
  extensionDir: string;
  configPath: string;
  cacheDir: string;
  apiKey?: string | undefined;
  resolveTtlMs: number;
  docsTtlMs: number;
  configError?: string | undefined;
}

interface SearchResult {
  id: string;
  title: string;
  description: string;
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
}

interface SearchResponse {
  results: SearchResult[];
  searchFilterApplied?: boolean | undefined;
  error?: string;
}

interface Context7ApiError {
  kind: "auth" | "rate_limit" | "not_found" | "network" | "invalid_response" | "unknown";
  status?: number;
  message: string;
  upstreamMessage?: string | undefined;
}

type Context7ApiResult<T> = { ok: true; data: T } | { ok: false; error: Context7ApiError };

interface ResolveCacheEntry {
  kind: "resolve";
  cacheKey: string;
  objectKey: string;
  libraryName: string;
  normalizedLibraryName: string;
  query: string;
  createdAt: string;
  expiresAt: string;
  results: SearchResult[];
}

interface ResolveCacheIndexEntry {
  kind: "resolve";
  cacheKey: string;
  objectKey: string;
  libraryName: string;
  normalizedLibraryName: string;
  query: string;
  createdAt: string;
  expiresAt: string;
  resultCount: number;
}

interface DocCacheEntry {
  kind: "docs";
  docRef: string;
  objectKey: string;
  libraryId: string;
  libraryName: string;
  normalizedLibraryName: string;
  libraryVersion?: string | undefined;
  libraryVersionRaw?: string | undefined;
  query: string;
  topic?: string | undefined;
  effectiveQuery: string;
  page: number;
  createdAt: string;
  expiresAt: string;
  rawText: string;
  curatedText: string;
}

export interface DocCacheIndexEntry {
  kind: "docs";
  docRef: string;
  objectKey: string;
  libraryId: string;
  libraryName: string;
  normalizedLibraryName: string;
  libraryVersion?: string | undefined;
  libraryVersionRaw?: string | undefined;
  query: string;
  topic?: string | undefined;
  effectiveQuery: string;
  page: number;
  createdAt: string;
  expiresAt: string;
  rawLength: number;
  curatedLength: number;
}

interface CacheLookup<T> {
  entry?: T;
  fresh: boolean;
}

interface CacheSearchSelector {
  docRef?: string;
  libraryId?: string;
  libraryName?: string;
  libraryVersion?: string;
  query?: string;
  topic?: string;
  page?: number | undefined;
}

interface CuratedDocResult {
  text: string;
  truncated: boolean;
  selectedSectionCount: number;
  rawLength: number;
}

interface ResolveLibraryParams {
  libraryName: string;
  query?: string | undefined;
}

interface GetLibraryDocsParams {
  libraryId?: string;
  libraryName?: string;
  query?: string;
  topic?: string;
  page?: number;
}

// --- Cache mutation queue ---

let mutationQueue: Promise<void> = Promise.resolve();

async function withMutationQueue<T>(fn: () => Promise<T>): Promise<T> {
  const promise = mutationQueue.then(() => fn());
  mutationQueue = promise.then(
    () => {},
    () => {},
  );
  return promise;
}

// --- Config ---

function getExtensionDir(): string {
  return join(homedir(), ".pi", "agent", "extensions", "context7");
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

async function loadSettings(): Promise<Context7Settings> {
  const extensionDir = getExtensionDir();
  const configPath = join(extensionDir, "config.json");
  const cacheDir = join(extensionDir, "cache");

  let config: Context7ConfigFile = {};
  let configError: string | undefined;

  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf8");
      config = JSON.parse(raw) as Context7ConfigFile;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
  }

  const apiKey = process.env.CONTEXT7_API_KEY?.trim() || config.apiKey?.trim() || undefined;
  const resolveTtlHours = normalizePositiveNumber(
    config.cache?.resolveTtlHours,
    DEFAULT_RESOLVE_TTL_HOURS,
  );
  const docsTtlHours = normalizePositiveNumber(config.cache?.docsTtlHours, DEFAULT_DOCS_TTL_HOURS);

  return {
    extensionDir,
    configPath,
    cacheDir,
    apiKey,
    resolveTtlMs: resolveTtlHours * 60 * 60 * 1000,
    docsTtlMs: docsTtlHours * 60 * 60 * 1000,
    configError,
  };
}

// --- Cache helpers ---

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function normalizeText(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isFresh(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() > Date.now();
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    const raw = await readFile(path, "utf8");
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, path);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pushIndexValue(map: Record<string, string[]>, key: string | undefined, value: string) {
  if (!key) return;
  map[key] = uniqueStrings([...(map[key] ?? []), value]);
}

type StringListMap = Record<string, string[]>;
type DocRefIndexMap = Record<string, DocCacheIndexEntry>;

function getResolvePaths(settings: Context7Settings, objectKey: string) {
  const base = join(settings.cacheDir, "resolve");
  const indexDir = join(base, "index");
  return {
    base,
    objectsDir: join(base, "objects"),
    indexDir,
    allIndexPath: join(indexDir, "all.json"),
    byLibraryPath: join(indexDir, "by-library.json"),
    objectPath: join(base, "objects", `${objectKey}.json`),
  };
}

function getDocsPaths(settings: Context7Settings, objectKey: string) {
  const base = join(settings.cacheDir, "docs");
  const indexDir = join(base, "index");
  return {
    base,
    objectsDir: join(base, "objects"),
    indexDir,
    allIndexPath: join(indexDir, "all.json"),
    byRefPath: join(indexDir, "by-ref.json"),
    byLibraryIdPath: join(indexDir, "by-library-id.json"),
    byLibraryNamePath: join(indexDir, "by-library-name.json"),
    byVersionPath: join(indexDir, "by-version.json"),
    objectPath: join(base, "objects", `${objectKey}.json`),
  };
}

async function ensureResolveCacheDirs(settings: Context7Settings, objectKey: string) {
  const paths = getResolvePaths(settings, objectKey);
  await mkdir(paths.objectsDir, { recursive: true });
  await mkdir(paths.indexDir, { recursive: true });
  return paths;
}

async function ensureDocsCacheDirs(settings: Context7Settings, objectKey: string) {
  const paths = getDocsPaths(settings, objectKey);
  await mkdir(paths.objectsDir, { recursive: true });
  await mkdir(paths.indexDir, { recursive: true });
  return paths;
}

function resolveCacheKey(libraryName: string, query: string): string {
  return `${normalizeText(libraryName)}::${normalizeText(query)}`;
}

async function pruneObjectDirectory(objectsDir: string, validObjectKeys: Set<string>) {
  if (!existsSync(objectsDir)) return;
  const files = await readdir(objectsDir);
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .filter((file) => !validObjectKeys.has(file.replace(/\.json$/, "")))
      .map((file) => rm(join(objectsDir, file), { force: true })),
  );
}

async function writeResolveIndexes(
  paths: ReturnType<typeof getResolvePaths>,
  all: ResolveCacheIndexEntry[],
) {
  const byLibrary: StringListMap = {};
  for (const entry of all) {
    pushIndexValue(byLibrary, entry.normalizedLibraryName, entry.objectKey);
  }
  await atomicWriteJson(paths.allIndexPath, all);
  await atomicWriteJson(paths.byLibraryPath, byLibrary);
}

async function writeDocsIndexes(paths: ReturnType<typeof getDocsPaths>, all: DocCacheIndexEntry[]) {
  const byRef: DocRefIndexMap = {};
  const byLibraryId: StringListMap = {};
  const byLibraryName: StringListMap = {};
  const byVersion: StringListMap = {};

  for (const entry of all) {
    byRef[entry.docRef] = entry;
    pushIndexValue(byLibraryId, entry.libraryId, entry.docRef);
    pushIndexValue(byLibraryName, entry.normalizedLibraryName, entry.docRef);
    pushIndexValue(byVersion, entry.libraryVersion, entry.docRef);
    pushIndexValue(byVersion, entry.libraryVersionRaw, entry.docRef);
  }

  await atomicWriteJson(paths.allIndexPath, all);
  await atomicWriteJson(paths.byRefPath, byRef);
  await atomicWriteJson(paths.byLibraryIdPath, byLibraryId);
  await atomicWriteJson(paths.byLibraryNamePath, byLibraryName);
  await atomicWriteJson(paths.byVersionPath, byVersion);
}

async function pruneResolveIndexes(
  paths: ReturnType<typeof getResolvePaths>,
  all: ResolveCacheIndexEntry[],
) {
  const seen = new Set<string>();
  const nextAll = all
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((entry) => {
      if (seen.has(entry.objectKey)) return false;
      seen.add(entry.objectKey);
      if (!isFresh(entry.expiresAt)) return false;
      return existsSync(join(paths.objectsDir, `${entry.objectKey}.json`));
    });

  await pruneObjectDirectory(paths.objectsDir, new Set(nextAll.map((entry) => entry.objectKey)));
  await writeResolveIndexes(paths, nextAll);
  return nextAll;
}

async function pruneDocsIndexes(paths: ReturnType<typeof getDocsPaths>, all: DocCacheIndexEntry[]) {
  const seen = new Set<string>();
  const nextAll = all
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((entry) => {
      if (seen.has(entry.docRef)) return false;
      seen.add(entry.docRef);
      if (!isFresh(entry.expiresAt)) return false;
      return existsSync(join(paths.objectsDir, `${entry.objectKey}.json`));
    });

  await pruneObjectDirectory(paths.objectsDir, new Set(nextAll.map((entry) => entry.objectKey)));
  await writeDocsIndexes(paths, nextAll);
  return nextAll;
}

async function readResolveIndexes(paths: ReturnType<typeof getResolvePaths>) {
  const all = await readJsonFile<ResolveCacheIndexEntry[]>(paths.allIndexPath, []);
  const pruned = await pruneResolveIndexes(paths, all);
  const byLibrary = await readJsonFile<StringListMap>(paths.byLibraryPath, {});
  return { all: pruned, byLibrary };
}

async function readDocsIndexes(paths: ReturnType<typeof getDocsPaths>) {
  const all = await readJsonFile<DocCacheIndexEntry[]>(paths.allIndexPath, []);
  const pruned = await pruneDocsIndexes(paths, all);
  const byRef = await readJsonFile<DocRefIndexMap>(paths.byRefPath, {});
  const byLibraryId = await readJsonFile<StringListMap>(paths.byLibraryIdPath, {});
  const byLibraryName = await readJsonFile<StringListMap>(paths.byLibraryNamePath, {});
  const byVersion = await readJsonFile<StringListMap>(paths.byVersionPath, {});
  return { all: pruned, byRef, byLibraryId, byLibraryName, byVersion };
}

function buildDocRef(libraryId: string, effectiveQuery: string, page: number): string {
  return `ctx7:docs:${hash(`${libraryId}::${effectiveQuery}::${page}`)}`;
}

function extractVersionInfo(libraryId: string): { raw?: string; normalized?: string } {
  const parts = libraryId.split("/").filter(Boolean);
  if (parts.length <= 2) return {};
  const raw = parts.slice(2).join("/");
  return {
    raw,
    normalized: raw.replace(/^v/, ""),
  };
}

async function getResolveCache(
  settings: Context7Settings,
  libraryName: string,
  query: string,
): Promise<CacheLookup<ResolveCacheEntry>> {
  const cacheKey = resolveCacheKey(libraryName, query);
  const objectKey = hash(cacheKey);
  const { objectPath } = getResolvePaths(settings, objectKey);
  if (!existsSync(objectPath)) return { fresh: false };

  const entry = await readJsonFile<ResolveCacheEntry | undefined>(objectPath, undefined);
  if (!entry) return { fresh: false };

  if (!isFresh(entry.expiresAt)) {
    await rm(objectPath, { force: true });
    return { fresh: false };
  }

  return { entry, fresh: true };
}

async function putResolveCache(
  settings: Context7Settings,
  params: { libraryName: string; query: string; results: SearchResult[] },
): Promise<ResolveCacheEntry> {
  const cacheKey = resolveCacheKey(params.libraryName, params.query);
  const objectKey = hash(cacheKey);
  const now = Date.now();
  const entry: ResolveCacheEntry = {
    kind: "resolve",
    cacheKey,
    objectKey,
    libraryName: params.libraryName,
    normalizedLibraryName: normalizeText(params.libraryName),
    query: params.query,
    createdAt: toIso(now),
    expiresAt: toIso(now + settings.resolveTtlMs),
    results: params.results,
  };

  const paths = await ensureResolveCacheDirs(settings, objectKey);

  await withMutationQueue(async () => {
    const { all } = await readResolveIndexes(paths);
    const nextAll = all
      .filter((item) => item.objectKey !== objectKey)
      .concat({
        kind: "resolve",
        cacheKey,
        objectKey,
        libraryName: entry.libraryName,
        normalizedLibraryName: entry.normalizedLibraryName,
        query: entry.query,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        resultCount: entry.results.length,
      });

    await atomicWriteJson(paths.objectPath, entry);
    await pruneResolveIndexes(paths, nextAll);
  });

  return entry;
}

async function getDocCacheByRef(
  settings: Context7Settings,
  docRef: string,
): Promise<CacheLookup<DocCacheEntry>> {
  const objectKey = hash(docRef);
  const { objectPath } = getDocsPaths(settings, objectKey);
  if (!existsSync(objectPath)) return { fresh: false };

  const entry = await readJsonFile<DocCacheEntry | undefined>(objectPath, undefined);
  if (!entry) return { fresh: false };

  if (!isFresh(entry.expiresAt)) {
    return { entry, fresh: false };
  }

  return { entry, fresh: true };
}

async function putDocCache(
  settings: Context7Settings,
  params: Omit<DocCacheEntry, "kind" | "objectKey" | "createdAt" | "expiresAt">,
): Promise<DocCacheEntry> {
  const objectKey = hash(params.docRef);
  const now = Date.now();
  const entry: DocCacheEntry = {
    ...params,
    kind: "docs",
    objectKey,
    createdAt: toIso(now),
    expiresAt: toIso(now + settings.docsTtlMs),
  };

  const paths = await ensureDocsCacheDirs(settings, objectKey);

  await withMutationQueue(async () => {
    const { all } = await readDocsIndexes(paths);
    const nextAll = all
      .filter((item) => item.docRef !== entry.docRef)
      .concat({
        kind: "docs",
        docRef: entry.docRef,
        objectKey,
        libraryId: entry.libraryId,
        libraryName: entry.libraryName,
        normalizedLibraryName: entry.normalizedLibraryName,
        libraryVersion: entry.libraryVersion,
        libraryVersionRaw: entry.libraryVersionRaw,
        query: entry.query,
        topic: entry.topic,
        effectiveQuery: entry.effectiveQuery,
        page: entry.page,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        rawLength: entry.rawText.length,
        curatedLength: entry.curatedText.length,
      });

    await atomicWriteJson(paths.objectPath, entry);
    await pruneDocsIndexes(paths, nextAll);
  });

  return entry;
}

function intersectDocRefs(
  current: string[] | undefined,
  next: string[] | undefined,
): string[] | undefined {
  if (!next || next.length === 0) return current;
  if (!current) return uniqueStrings(next);
  const nextSet = new Set(next);
  return current.filter((value) => nextSet.has(value));
}

async function findDocCacheCandidates(
  settings: Context7Settings,
  selector: CacheSearchSelector,
): Promise<DocCacheIndexEntry[]> {
  const paths = getDocsPaths(settings, "placeholder");
  const { all, byRef, byLibraryId, byLibraryName, byVersion } = await readDocsIndexes(paths);

  if (selector.docRef) {
    const exact = byRef[selector.docRef];
    if (!exact) return [];
    return [exact];
  }

  const normalizedLibraryName = normalizeText(selector.libraryName);
  const normalizedVersion = normalizeText(selector.libraryVersion).replace(/^v/, "");
  const normalizedQuery = normalizeText(selector.query);
  const normalizedTopic = normalizeText(selector.topic);

  let seededDocRefs: string[] | undefined;
  if (selector.libraryId)
    seededDocRefs = intersectDocRefs(seededDocRefs, byLibraryId[selector.libraryId]);
  if (normalizedLibraryName)
    seededDocRefs = intersectDocRefs(seededDocRefs, byLibraryName[normalizedLibraryName]);
  if (normalizedVersion)
    seededDocRefs = intersectDocRefs(seededDocRefs, byVersion[normalizedVersion]);

  const candidatePool: DocCacheIndexEntry[] = seededDocRefs
    ? seededDocRefs
        .map((docRef) => byRef[docRef])
        .filter((entry): entry is DocCacheIndexEntry => entry !== undefined)
    : all;

  return candidatePool
    .filter((item) => (selector.libraryId ? item.libraryId === selector.libraryId : true))
    .filter((item) => {
      if (!normalizedLibraryName) return true;
      return (
        item.normalizedLibraryName === normalizedLibraryName ||
        item.normalizedLibraryName.includes(normalizedLibraryName) ||
        normalizedLibraryName.includes(item.normalizedLibraryName)
      );
    })
    .filter((item) => {
      if (!normalizedVersion) return true;
      return (
        item.libraryVersion === normalizedVersion ||
        normalizeText(item.libraryVersionRaw).replace(/^v/, "") === normalizedVersion
      );
    })
    .filter((item) => (normalizedQuery ? normalizeText(item.query) === normalizedQuery : true))
    .filter((item) => (normalizedTopic ? normalizeText(item.topic) === normalizedTopic : true))
    .filter((item) => (typeof selector.page === "number" ? item.page === selector.page : true))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function loadDocCacheObject(
  settings: Context7Settings,
  metadata: Pick<DocCacheIndexEntry, "objectKey">,
): Promise<DocCacheEntry | undefined> {
  const { objectPath } = getDocsPaths(settings, metadata.objectKey);
  return readJsonFile<DocCacheEntry | undefined>(objectPath, undefined);
}

// --- API ---

function buildHeaders(settings: Context7Settings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    "X-Context7-Source": "pi-extension",
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

async function parseErrorResponse(
  response: Response,
  settings: Context7Settings,
): Promise<Context7ApiError> {
  let upstreamMessage: string | undefined;
  try {
    const payload = (await response.json()) as { message?: string };
    if (typeof payload?.message === "string" && payload.message.trim()) {
      upstreamMessage = payload.message.trim();
    }
  } catch {
    // Ignore non-JSON error bodies.
  }

  if (response.status === 429) {
    return {
      kind: "rate_limit",
      status: response.status,
      message: settings.apiKey
        ? "Context7 rate limit exceeded. Retry later or use a higher-limit Context7 plan."
        : "Context7 rate limit exceeded. Retry later or configure CONTEXT7_API_KEY for higher limits.",
      upstreamMessage,
    };
  }
  if (response.status === 401) {
    return {
      kind: "auth",
      status: response.status,
      message: "Context7 API key appears invalid.",
      upstreamMessage,
    };
  }
  if (response.status === 404) {
    return {
      kind: "not_found",
      status: response.status,
      message: "No Context7 documentation was found for that library identifier.",
      upstreamMessage,
    };
  }
  return {
    kind: "unknown",
    status: response.status,
    message: `Context7 request failed with status ${response.status}.`,
    upstreamMessage,
  };
}

async function searchLibraries(
  settings: Context7Settings,
  params: { libraryName: string; query: string },
): Promise<Context7ApiResult<SearchResponse>> {
  try {
    const url = new URL(`${CONTEXT7_API_BASE_URL}/v2/libs/search`);
    url.searchParams.set("query", params.query);
    url.searchParams.set("libraryName", params.libraryName);

    const response = await fetch(url, { headers: buildHeaders(settings) });
    if (!response.ok) return { ok: false, error: await parseErrorResponse(response, settings) };

    const payload = (await response.json()) as SearchResponse;
    if (!payload || !Array.isArray(payload.results)) {
      return {
        ok: false,
        error: {
          kind: "invalid_response",
          message: "Context7 returned an invalid search response.",
        },
      };
    }

    return { ok: true, data: payload };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: "Unable to reach Context7 right now.",
        upstreamMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function fetchLibraryDocs(
  settings: Context7Settings,
  params: { libraryId: string; query: string },
): Promise<Context7ApiResult<string>> {
  try {
    const url = new URL(`${CONTEXT7_API_BASE_URL}/v2/context`);
    url.searchParams.set("libraryId", params.libraryId);
    url.searchParams.set("query", params.query);

    const response = await fetch(url, { headers: buildHeaders(settings) });
    if (!response.ok) return { ok: false, error: await parseErrorResponse(response, settings) };

    const text = await response.text();
    if (!text.trim()) {
      return {
        ok: false,
        error: {
          kind: "not_found",
          message:
            "Context7 returned an empty documentation response. Try resolving the library again or refining the query.",
        },
      };
    }

    return { ok: true, data: text };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: "Unable to reach Context7 right now.",
        upstreamMessage: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// --- Curation ---

interface Section {
  text: string;
  score: number;
  index: number;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractKeywords(query?: string, topic?: string): string[] {
  const source = `${query ?? ""} ${topic ?? ""}`.toLowerCase();
  const words = source.match(/[a-z0-9._/-]{3,}/g) ?? [];
  const unique = new Set<string>();

  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    unique.add(word);
  }

  return Array.from(unique).slice(0, 12);
}

function splitIntoSections(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const sections: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const chunk = buffer.join("\n").trim();
    if (chunk) sections.push(chunk);
    buffer = [];
  };

  for (const line of lines) {
    const isHeading =
      /^#{1,6}\s+/.test(line) || (/^[A-Z][^\n]{0,100}:$/.test(line) && line.length < 100);
    if (isHeading && buffer.length > 0) flush();
    buffer.push(line);
    if (!line.trim()) flush();
  }

  flush();
  return sections.filter(Boolean);
}

function scoreSection(section: string, keywords: string[], index: number): number {
  if (keywords.length === 0) return Math.max(0, 10 - index);

  const lower = section.toLowerCase();
  const lines = section.split("\n");
  const heading = lines[0]?.toLowerCase() ?? "";

  let score = Math.max(0, 8 - index);
  for (const keyword of keywords) {
    const occurrences = lower.split(keyword).length - 1;
    if (occurrences > 0) score += occurrences * 4;
    if (heading.includes(keyword)) score += 6;
  }

  return score;
}

function chooseSections(text: string, query?: string, topic?: string): Section[] {
  const keywords = extractKeywords(query, topic);
  const sections = splitIntoSections(text).map((section, index) => ({
    text: section,
    score: scoreSection(section, keywords, index),
    index,
  }));

  if (sections.length === 0) return [];

  const highSignal = sections
    .filter((section) => section.score > 8)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = (
    highSignal.length > 0 ? highSignal : sections.slice().sort((a, b) => a.index - b.index)
  ).slice(0, 12);

  return picked.sort((a, b) => a.index - b.index);
}

function curateDocText(input: {
  rawText: string;
  libraryId: string;
  libraryName: string;
  libraryVersion?: string | undefined;
  query?: string | undefined;
  topic?: string | undefined;
  page: number;
  docRef: string;
}): CuratedDocResult {
  const sections = chooseSections(input.rawText, input.query, input.topic);

  const headerLines = [
    `Library: ${input.libraryName}`,
    `Library ID: ${input.libraryId}`,
    input.libraryVersion ? `Version: ${input.libraryVersion}` : undefined,
    input.query ? `Query: ${input.query}` : undefined,
    input.topic ? `Topic: ${input.topic}` : undefined,
    `Page: ${input.page}`,
    "",
    "Relevant documentation:",
    "",
  ].filter(Boolean) as string[];

  const footerLines = ["", `Raw cached document available via docRef: ${input.docRef}`];

  let selectedSectionCount = 0;
  let body = "";
  let truncated = false;
  const budget = Math.max(
    2_000,
    MAX_CURATED_CHARS - headerLines.join("\n").length - footerLines.join("\n").length,
  );

  for (const section of sections) {
    const next = body ? `${body}\n\n${section.text}` : section.text;
    if (next.length > budget) {
      if (!body) {
        body = section.text.slice(0, budget);
        truncated = true;
        selectedSectionCount = 1;
      }
      break;
    }
    body = next;
    selectedSectionCount += 1;
  }

  if (!body) {
    body = normalizeWhitespace(input.rawText).slice(0, budget);
    truncated = normalizeWhitespace(input.rawText).length > budget;
    selectedSectionCount = body ? 1 : 0;
  }

  if (!truncated && normalizeWhitespace(input.rawText).length > body.length) {
    truncated = body.length < normalizeWhitespace(input.rawText).length;
  }

  const text = `${headerLines.join("\n")}${body}${footerLines.join("\n")}`.trim();

  return {
    text,
    truncated,
    selectedSectionCount,
    rawLength: normalizeWhitespace(input.rawText).length,
  };
}

// --- Tool parameter schemas ---

const RESOLVE_LIBRARY_PARAMS = {
  type: "object",
  properties: {
    libraryName: {
      type: "string",
      description: "Library or package name to resolve in Context7.",
    },
    query: {
      type: "string",
      description: "Optional task or intent to help rank the best Context7 library match.",
    },
  },
  required: ["libraryName"],
};

const GET_LIBRARY_DOCS_PARAMS = {
  type: "object",
  properties: {
    libraryId: {
      type: "string",
      description: "Exact Context7 library ID, such as /vercel/next.js.",
    },
    libraryName: {
      type: "string",
      description: "Library or package name when an exact Context7 ID is not known.",
    },
    query: {
      type: "string",
      description: "Freeform documentation request or question.",
    },
    topic: {
      type: "string",
      description: "Optional focused topic inside the docs.",
    },
    page: {
      type: "number",
      description: "Optional logical page number for repeated docs retrieval attempts.",
    },
  },
  required: [],
};

const GET_CACHED_DOC_RAW_PARAMS = {
  type: "object",
  properties: {
    docRef: {
      type: "string",
      description: "Exact docRef returned by context7_get_library_docs.",
    },
    libraryId: {
      type: "string",
      description: "Optional Context7 library ID for semantic cache lookup.",
    },
    libraryName: {
      type: "string",
      description: "Optional library name for semantic cache lookup.",
    },
    libraryVersion: {
      type: "string",
      description: "Optional library version for semantic cache lookup.",
    },
    query: {
      type: "string",
      description: "Optional original query used to fetch docs.",
    },
    topic: {
      type: "string",
      description: "Optional original topic used to fetch docs.",
    },
    page: {
      type: "number",
      description: "Optional original logical page number.",
    },
  },
  required: [],
};

// --- Tool logic helpers ---

function displayTitle(result?: SearchResult): string {
  if (!result) return "";
  return result.title || result.id;
}

function snippetCount(result: SearchResult): number {
  return typeof result.totalSnippets === "number" && result.totalSnippets > 0
    ? result.totalSnippets
    : 0;
}

function benchmarkScore(result: SearchResult): number {
  return typeof result.benchmarkScore === "number" ? result.benchmarkScore : 0;
}

function trustScore(result: SearchResult): number {
  return typeof result.trustScore === "number" ? result.trustScore : 0;
}

function selectBestLibrary(
  results: SearchResult[],
  libraryName: string,
): { selected?: SearchResult; ambiguous: boolean } {
  if (results.length === 0) return { ambiguous: false };
  if (results.length === 1) {
    const only = results[0];
    if (!only) return { ambiguous: false };
    return { selected: only, ambiguous: false };
  }

  const target = normalizeText(libraryName).replace(/^@/, "");
  const scored = results
    .map((result) => {
      const title = normalizeText(result.title);
      const id = normalizeText(result.id);
      let score =
        benchmarkScore(result) / 10 + trustScore(result) + Math.min(snippetCount(result), 100) / 20;
      if (title === target) score += 25;
      if (title.includes(target)) score += 12;
      if (id.endsWith(`/${target}`) || id.includes(`/${target}/`)) score += 12;
      return { result, score };
    })
    .sort((a, b) => b.score - a.score);

  const [top, second] = scored;
  if (!top) return { ambiguous: true };
  if (!second) return { selected: top.result, ambiguous: false };

  const clearByExactMatch =
    normalizeText(top.result.title) === target ||
    normalizeText(top.result.id).endsWith(`/${target}`) ||
    top.score >= second.score + 8;

  if (clearByExactMatch) return { selected: top.result, ambiguous: false };
  return { ambiguous: true };
}

function formatResolveCandidate(result: SearchResult): string {
  const parts = [
    `- Title: ${displayTitle(result)}`,
    `  Library ID: ${result.id}`,
    `  Description: ${result.description}`,
  ];

  if (snippetCount(result) > 0) parts.push(`  Code Snippets: ${snippetCount(result)}`);
  if (trustScore(result) > 0) parts.push(`  Source Reputation Score: ${trustScore(result)}`);
  if (benchmarkScore(result) > 0) parts.push(`  Benchmark Score: ${benchmarkScore(result)}`);
  if (result.versions?.length) parts.push(`  Versions: ${result.versions.join(", ")}`);
  if (result.source) parts.push(`  Source: ${result.source}`);

  return parts.join("\n");
}

function formatResolveResults(
  response: SearchResponse,
  libraryName: string,
): { text: string; recommended?: SearchResult; ambiguous: boolean } {
  if (!response.results.length) {
    return {
      text: `No Context7 libraries matched "${libraryName}".`,
      ambiguous: false,
    };
  }

  const recommendation = selectBestLibrary(response.results, libraryName);
  const header = [
    `Context7 matches for "${libraryName}":`,
    recommendation.selected ? `Recommended library ID: ${recommendation.selected.id}` : undefined,
    recommendation.ambiguous
      ? "Auto-resolution is ambiguous; choose one of the candidates below."
      : undefined,
    "",
  ].filter(Boolean) as string[];

  const body = response.results.slice(0, 8).map(formatResolveCandidate).join("\n----------\n");
  return {
    text: `${header.join("\n")}${body}`,
    ...(recommendation.selected ? { recommended: recommendation.selected } : {}),
    ambiguous: recommendation.ambiguous,
  };
}

function buildEffectiveQuery(query?: string, topic?: string, page?: number): string {
  const parts = [query?.trim(), topic?.trim() ? `Focus: ${topic.trim()}` : undefined];
  if (typeof page === "number" && page > 1) parts.push(`Requested page: ${page}`);
  return parts.filter(Boolean).join("\n\n") || "overview";
}

function summarizeError(
  error: { message: string; upstreamMessage?: string | undefined },
  extra?: string,
): string {
  return [error.message, extra].filter(Boolean).join(" ");
}

async function resolveLibraries(params: ResolveLibraryParams) {
  const settings = await loadSettings();
  const query = params.query?.trim() || params.libraryName.trim();
  const cached = await getResolveCache(settings, params.libraryName, query);

  if (cached.entry && cached.fresh) {
    return {
      source: "fresh-cache" as const,
      response: { results: cached.entry.results },
      configError: settings.configError,
    };
  }

  const network = await searchLibraries(settings, { libraryName: params.libraryName, query });
  if (network.ok) {
    const entry = await putResolveCache(settings, {
      libraryName: params.libraryName,
      query,
      results: network.data.results,
    });
    return {
      source: "network" as const,
      response: { results: entry.results, searchFilterApplied: network.data.searchFilterApplied },
      configError: settings.configError,
    };
  }

  if (cached.entry) {
    return {
      source: "stale-cache" as const,
      response: { results: cached.entry.results },
      configError: settings.configError,
      staleBecause: network.error,
    };
  }

  throw Object.assign(
    new Error(
      summarizeError(
        network.error,
        settings.configError ? `Config parse issue: ${settings.configError}` : undefined,
      ),
    ),
    {
      details: { upstreamError: network.error, configError: settings.configError },
    },
  );
}

function formatCacheCandidates(candidates: DocCacheIndexEntry[]): string {
  return candidates
    .slice(0, 8)
    .map((candidate) => {
      const parts = [
        `- docRef: ${candidate.docRef}`,
        `  Library: ${candidate.libraryName}`,
        `  Library ID: ${candidate.libraryId}`,
        candidate.libraryVersion ? `  Version: ${candidate.libraryVersion}` : undefined,
        candidate.topic ? `  Topic: ${candidate.topic}` : undefined,
        `  Query: ${candidate.query}`,
        `  Page: ${candidate.page}`,
        `  Cached At: ${candidate.createdAt}`,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n----------\n");
}

function normalizedLibraryNameFromResult(result?: SearchResult, fallback?: string): string {
  return normalizeText(result?.title || fallback || "unknown-library");
}

async function getDocsEntry(params: GetLibraryDocsParams) {
  const settings = await loadSettings();
  const page =
    typeof params.page === "number" && Number.isFinite(params.page)
      ? Math.max(1, Math.floor(params.page))
      : 1;
  const effectiveQuery = buildEffectiveQuery(params.query, params.topic, page);

  let libraryId = params.libraryId?.trim();
  let libraryName = params.libraryName?.trim();
  let resolvedResult: SearchResult | undefined;
  let resolveMetadata: Record<string, unknown> | undefined;

  if (!libraryId) {
    if (!libraryName) {
      throw new Error("context7_get_library_docs requires either libraryId or libraryName.");
    }

    const resolveResult = await resolveLibraries({ libraryName, query: params.query });
    const formatted = formatResolveResults(resolveResult.response, libraryName);
    resolveMetadata = {
      source: resolveResult.source,
      staleBecause: resolveResult.staleBecause,
      configError: resolveResult.configError,
    };

    if (!formatted.recommended || formatted.ambiguous) {
      return {
        ok: false as const,
        text: `${formatted.text}\n\nUnable to safely auto-resolve before fetching docs. Call context7_resolve_library_id first or pass an exact libraryId.`,
        details: {
          needsResolution: true,
          candidates: resolveResult.response.results.slice(0, 8),
          resolve: resolveMetadata,
        },
      };
    }

    libraryId = formatted.recommended.id;
    resolvedResult = formatted.recommended;
    libraryName = displayTitle(formatted.recommended);
  }

  const docRef = buildDocRef(libraryId, effectiveQuery, page);
  const cached = await getDocCacheByRef(settings, docRef);
  if (cached.entry && cached.fresh) {
    return {
      ok: true as const,
      entry: cached.entry,
      source: "fresh-cache" as const,
      details: {
        docRef,
        cacheStatus: "fresh",
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    };
  }

  const network = await fetchLibraryDocs(settings, { libraryId, query: effectiveQuery });
  if (network.ok) {
    const version = extractVersionInfo(libraryId);
    const curated = curateDocText({
      rawText: network.data,
      libraryId,
      libraryName: libraryName || displayTitle(resolvedResult) || libraryId,
      libraryVersion: version.normalized,
      query: params.query,
      topic: params.topic,
      page,
      docRef,
    });

    const entry = await putDocCache(settings, {
      docRef,
      libraryId,
      libraryName: libraryName || displayTitle(resolvedResult) || libraryId,
      normalizedLibraryName: normalizedLibraryNameFromResult(resolvedResult, libraryName),
      libraryVersion: version.normalized,
      libraryVersionRaw: version.raw,
      query: params.query?.trim() || "overview",
      topic: params.topic?.trim(),
      effectiveQuery,
      page,
      rawText: network.data,
      curatedText: curated.text,
    });

    return {
      ok: true as const,
      entry,
      source: "network" as const,
      details: {
        docRef,
        cacheStatus: "refreshed",
        resolve: resolveMetadata,
        curation: {
          truncated: curated.truncated,
          selectedSectionCount: curated.selectedSectionCount,
          rawLength: curated.rawLength,
        },
        configError: settings.configError,
      },
    };
  }

  if (cached.entry) {
    return {
      ok: true as const,
      entry: cached.entry,
      source: "stale-cache" as const,
      details: {
        docRef,
        cacheStatus: "stale",
        staleBecause: network.error,
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    };
  }

  throw Object.assign(
    new Error(
      summarizeError(
        network.error,
        settings.configError ? `Config parse issue: ${settings.configError}` : undefined,
      ),
    ),
    {
      details: {
        upstreamError: network.error,
        resolve: resolveMetadata,
        configError: settings.configError,
      },
    },
  );
}

function wrapMultilineText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
    } else {
      lines.push(...wrapTextWithAnsi(paragraph, width));
    }
  }
  return lines;
}

function createResolveRenderResult() {
  return (result: any, options: any, theme: any, context: any) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args as ResolveLibraryParams;
    const libraryName = args.libraryName ?? "unknown";

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("error", `✗ Resolve: "${libraryName}" — ${errorText}`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.isPartial) {
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("warning", `📚 Resolving: "${libraryName}"...`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.expanded) {
      const results = details?.results as SearchResult[] | undefined;
      if (results && results.length > 0) {
        const limit = 5;
        const visible = results.slice(0, limit);
        let text = "";
        for (const r of visible) {
          const metaParts: string[] = [];
          if (typeof r.totalSnippets === "number" && r.totalSnippets > 0)
            metaParts.push(`${r.totalSnippets} snippets`);
          if (typeof r.benchmarkScore === "number" && r.benchmarkScore > 0)
            metaParts.push(`score ${r.benchmarkScore}`);
          const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
          text += `${theme.fg("dim", `• ${r.title || "Untitled"} — ${r.id}${meta}`)}\n`;
        }
        if (results.length > limit) {
          text += theme.fg("muted", `... and ${results.length - limit} more`);
        }
        return {
          render: (width: number) => wrapMultilineText(text.trimEnd(), width),
          invalidate: () => {},
        };
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return {
        render: (width: number) => wrapMultilineText(text, width),
        invalidate: () => {},
      };
    }

    const ambiguous = Boolean(details?.ambiguous);
    const recommended = String(details?.recommendedLibraryId ?? "");
    const resultCount = Array.isArray(details?.results)
      ? (details.results as SearchResult[]).length
      : 0;

    let label: string;
    if (ambiguous) {
      label = `ambiguous (${resultCount} candidates)`;
    } else if (recommended) {
      label = `→ ${recommended}`;
    } else if (resultCount === 0) {
      label = "no matches";
    } else {
      label = `${resultCount} candidate${resultCount !== 1 ? "s" : ""}`;
    }

    const source = String(details?.source ?? "");
    const cacheNote =
      source === "fresh-cache" ? " (cached)" : source === "stale-cache" ? " (stale)" : "";

    return {
      render: (width: number) => [
        truncateToWidth(
          theme.fg("success", `📚 Resolve: "${libraryName}" ${label}${cacheNote}`),
          width,
        ),
      ],
      invalidate: () => {},
    };
  };
}

function createDocsRenderResult() {
  return (result: any, options: any, theme: any, context: any) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args as GetLibraryDocsParams;
    const displayName = args.libraryName || args.libraryId || "unknown";

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("error", `✗ Docs: ${displayName} — ${errorText}`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.isPartial) {
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("warning", `📖 Fetching docs: ${displayName}...`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.expanded) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = text.split("\n");
      const limit = 10;
      const visible = lines.slice(0, limit);
      let preview = "";
      for (const line of visible) {
        preview += `${theme.fg("dim", line)}\n`;
      }
      if (lines.length > limit) {
        preview += theme.fg("muted", `... and ${lines.length - limit} more lines`);
      }
      return {
        render: (width: number) => wrapMultilineText(preview.trimEnd(), width),
        invalidate: () => {},
      };
    }

    const needsResolution = Boolean(details?.needsResolution);
    const cacheStatus = String(details?.cacheStatus ?? "");
    const query = String(args.query ?? "");
    const cacheNote =
      cacheStatus === "fresh"
        ? " (cached)"
        : cacheStatus === "stale"
          ? " (stale)"
          : cacheStatus === "refreshed"
            ? " (refreshed)"
            : "";
    const queryPart = query ? ` — ${query.slice(0, 30)}${query.length > 30 ? "..." : ""}` : "";

    if (needsResolution) {
      return {
        render: (width: number) => [
          truncateToWidth(
            theme.fg("warning", `📖 Docs: ${displayName}${queryPart} — needs resolution`),
            width,
          ),
        ],
        invalidate: () => {},
      };
    }

    return {
      render: (width: number) => [
        truncateToWidth(
          theme.fg("success", `📖 Docs: ${displayName}${queryPart}${cacheNote}`),
          width,
        ),
      ],
      invalidate: () => {},
    };
  };
}

function createRawRenderResult() {
  return (result: any, options: any, theme: any, context: any) => {
    const details = result.details as Record<string, unknown> | undefined;
    const isError = context.isError || Boolean(details?.isError);
    const args = context.args as CacheSearchSelector;
    const docRef = String(args.docRef ?? details?.docRef ?? "unknown");

    if (isError) {
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("error", `✗ Raw: ${docRef} — ${errorText}`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.isPartial) {
      return {
        render: (width: number) => [
          truncateToWidth(theme.fg("warning", `📄 Loading raw docs...`), width),
        ],
        invalidate: () => {},
      };
    }

    if (options.expanded) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = text.split("\n");
      const limit = 10;
      const visible = lines.slice(0, limit);
      let preview = "";
      for (const line of visible) {
        preview += `${theme.fg("dim", line)}\n`;
      }
      if (lines.length > limit) {
        preview += theme.fg("muted", `... and ${lines.length - limit} more lines`);
      }
      return {
        render: (width: number) => wrapMultilineText(preview.trimEnd(), width),
        invalidate: () => {},
      };
    }

    const ambiguous = Boolean(details?.ambiguous);
    const candidateCount = Array.isArray(details?.candidates)
      ? (details.candidates as unknown[]).length
      : 0;
    const cacheStatus = String(details?.cacheStatus ?? "");
    const cacheNote =
      cacheStatus === "fresh" ? " (fresh)" : cacheStatus === "stale" ? " (stale)" : "";
    const libraryName = String(details?.libraryName ?? args.libraryName ?? "unknown");

    if (ambiguous) {
      return {
        render: (width: number) => [
          truncateToWidth(
            theme.fg("warning", `📄 Raw: ${libraryName} — ambiguous (${candidateCount})`),
            width,
          ),
        ],
        invalidate: () => {},
      };
    }

    return {
      render: (width: number) => [
        truncateToWidth(
          theme.fg(
            "success",
            `📄 Raw: ${libraryName} — ${docRef.slice(0, 40)}${docRef.length > 40 ? "..." : ""}${cacheNote}`,
          ),
          width,
        ),
      ],
      invalidate: () => {},
    };
  };
}

// --- Extension export ---

export default async function context7Extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "context7_resolve_library_id",
    label: "Context7 Resolve Library ID",
    description:
      "Resolve a library or package name to a Context7 library ID. Pi-native equivalent of Context7 MCP resolve-library-id.",
    promptSnippet:
      "Resolve a library or package name to a Context7 library ID before fetching docs when the exact ID is unknown.",
    promptGuidelines: [
      "Use context7_resolve_library_id when the user asks for library documentation and you do not already know the exact Context7 library ID.",
    ],
    parameters: RESOLVE_LIBRARY_PARAMS,
    renderResult: createResolveRenderResult(),
    async execute(_toolCallId, params) {
      const resolved = await resolveLibraries(params as ResolveLibraryParams);
      const formatted = formatResolveResults(resolved.response, params.libraryName as string);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          source: resolved.source,
          staleBecause: resolved.staleBecause,
          configError: resolved.configError,
          recommendedLibraryId: formatted.recommended?.id,
          ambiguous: formatted.ambiguous,
          results: resolved.response.results,
        },
      };
    },
  });

  pi.registerTool({
    name: "context7_get_library_docs",
    label: "Context7 Get Library Docs",
    description:
      "Fetch curated, up-to-date Context7 docs by library ID or library name. Pi-native equivalent of Context7 MCP get-library-docs / query-docs.",
    promptSnippet:
      "Fetch curated, up-to-date Context7 docs for a library by ID or by name. Equivalent to Context7 MCP get-library-docs/query-docs.",
    promptGuidelines: [
      "Prefer context7_get_library_docs over raw cached docs retrieval; use it first for normal documentation lookup.",
      "If you only know the library name, pass libraryName to context7_get_library_docs and let it auto-resolve.",
    ],
    parameters: GET_LIBRARY_DOCS_PARAMS,
    renderResult: createDocsRenderResult(),
    async execute(_toolCallId, params) {
      const result = await getDocsEntry(params as GetLibraryDocsParams);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        } as any;
      }

      const entry = result.entry;
      const notes: string[] = [];
      if (result.source === "stale-cache")
        notes.push("Returned stale cached docs because the network refresh failed.");
      if (result.source === "fresh-cache") notes.push("Returned fresh cached docs.");
      if (result.source === "network")
        notes.push("Fetched docs from Context7 and refreshed the local cache.");

      return {
        content: [{ type: "text", text: `${entry.curatedText}\n\n${notes.join(" ")}`.trim() }],
        details: {
          ...result.details,
          docRef: entry.docRef,
          libraryId: entry.libraryId,
          libraryName: entry.libraryName,
          libraryVersion: entry.libraryVersion,
          page: entry.page,
          query: entry.query,
          topic: entry.topic,
          effectiveQuery: entry.effectiveQuery,
        },
      } as any;
    },
  });

  pi.registerTool({
    name: "context7_get_cached_doc_raw",
    label: "Context7 Get Cached Raw Doc",
    description:
      "Read the raw cached Context7 document for a previous docs fetch. Prefer context7_get_library_docs first.",
    promptSnippet:
      "Read the full raw cached Context7 document by docRef or semantic lookup when curated docs were insufficient.",
    promptGuidelines: [
      "Use context7_get_cached_doc_raw only after context7_get_library_docs when you need the full cached raw documentation.",
      "When calling context7_get_cached_doc_raw, prefer docRef from an earlier tool result. If semantic lookup matches multiple cached docs, the tool will not guess.",
    ],
    parameters: GET_CACHED_DOC_RAW_PARAMS,
    renderResult: createRawRenderResult(),
    async execute(_toolCallId, params) {
      const settings = await loadSettings();
      const selector: CacheSearchSelector = {
        docRef: params.docRef?.trim(),
        libraryId: params.libraryId?.trim(),
        libraryName: params.libraryName?.trim(),
        libraryVersion: params.libraryVersion?.trim(),
        query: params.query?.trim(),
        topic: params.topic?.trim(),
        page: typeof params.page === "number" ? Math.max(1, Math.floor(params.page)) : undefined,
      };

      if (selector.docRef) {
        const cached = await getDocCacheByRef(settings, selector.docRef);
        if (!cached.entry) {
          throw new Error(
            `No cached Context7 document found for docRef ${selector.docRef}. Call context7_get_library_docs first.`,
          );
        }
        return {
          content: [{ type: "text", text: cached.entry.rawText }],
          details: {
            docRef: cached.entry.docRef,
            libraryId: cached.entry.libraryId,
            libraryName: cached.entry.libraryName,
            libraryVersion: cached.entry.libraryVersion,
            cacheStatus: cached.fresh ? "fresh" : "stale",
            query: cached.entry.query,
            topic: cached.entry.topic,
            page: cached.entry.page,
          },
        } as any;
      }

      if (
        !selector.libraryId &&
        !selector.libraryName &&
        !selector.libraryVersion &&
        !selector.query &&
        !selector.topic &&
        selector.page === undefined
      ) {
        throw new Error("context7_get_cached_doc_raw requires docRef or semantic lookup fields.");
      }

      const candidates = await findDocCacheCandidates(settings, selector);
      if (candidates.length === 0) {
        throw new Error(
          "No cached Context7 documents matched that lookup. Call context7_get_library_docs first.",
        );
      }

      if (candidates.length > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Multiple cached Context7 documents matched that lookup. Refine the lookup or use one of these docRefs:\n\n${formatCacheCandidates(candidates)}`,
            },
          ],
          details: {
            ambiguous: true,
            candidates,
          },
        } as any;
      }

      const only = candidates[0];
      if (!only) {
        throw new Error(
          "Context7 cache returned a candidate set that was unexpectedly empty after filtering.",
        );
      }
      const entry = await loadDocCacheObject(settings, only);
      if (!entry) {
        throw new Error(
          `Cached Context7 document metadata exists for ${only.docRef}, but the object file is missing.`,
        );
      }

      return {
        content: [{ type: "text", text: entry.rawText }],
        details: {
          docRef: entry.docRef,
          libraryId: entry.libraryId,
          libraryName: entry.libraryName,
          libraryVersion: entry.libraryVersion,
          cacheStatus: new Date(entry.expiresAt).getTime() > Date.now() ? "fresh" : "stale",
          query: entry.query,
          topic: entry.topic,
          page: entry.page,
        },
      } as any;
    },
  });
}
