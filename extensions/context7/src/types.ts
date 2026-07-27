// Shared contracts used across Context7 capability modules and the public entrypoint.

// --- Types ---

export interface Context7Settings {
  extensionDir: string;
  configPath: string;
  cacheDir: string;
  apiKey?: string | undefined;
  resolveTtlMs: number;
  docsTtlMs: number;
  configError?: string | undefined;
}

export interface SearchResult {
  id: string;
  title: string;
  description: string;
  totalSnippets?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
  source?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  searchFilterApplied?: boolean | undefined;
  error?: string;
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

export interface CacheSearchSelector {
  docRef?: string;
  libraryId?: string;
  libraryName?: string;
  libraryVersion?: string;
  query?: string;
  topic?: string;
  page?: number | undefined;
}

export interface ResolveLibraryParams {
  libraryName: string;
  query?: string | undefined;
}

export interface GetLibraryDocsParams {
  libraryId?: string;
  libraryName?: string;
  query?: string;
  topic?: string;
  page?: number;
}
