// --- Types ---

export interface CodeSearchFacetBucket {
  val: string;
  count: number;
}

export interface CodeSearchParams {
  query: string;
  language?: string;
  repo?: string;
  path?: string;
  max_results?: number;
}

// --- Sourcegraph stream shapes ---

export interface SourcegraphLineMatch {
  line?: string;
  lineNumber?: number;
}

export interface SourcegraphMatch {
  repository?: string;
  path?: string;
  branches?: string[];
  commit?: string;
  lineMatches?: SourcegraphLineMatch[];
  language?: string;
}

export interface SourcegraphFilter {
  value?: string;
  label?: string;
  count?: number;
  kind?: string;
}

export interface SourcegraphProgress {
  done?: boolean;
  matchCount?: number;
  repositoriesCount?: number;
}

/** Normalized data extracted from one completed SSE stream. */
export interface SourcegraphStreamData {
  matches: SourcegraphMatch[];
  topLanguages: CodeSearchFacetBucket[];
  topRepositories: CodeSearchFacetBucket[];
  totalResults: number;
}

// --- Tool result shapes ---

export interface CodeSearchFileResult {
  filePath: string;
  branch: string;
  totalMatches: number;
  lineNumbers: number[];
  language: string;
  codeSnippet: string;
}

export interface CodeSearchRepoResult {
  repository: string;
  matchesCount: number;
  files: CodeSearchFileResult[];
}

export interface CodeSearchDetails {
  query: string;
  totalResults: number;
  resultsShown: number;
  repositoriesFound: number;
  topLanguages: CodeSearchFacetBucket[];
  topRepositories: CodeSearchFacetBucket[];
  results: CodeSearchRepoResult[];
  filters?: {
    language?: string | undefined;
    repo?: string | undefined;
    path?: string | undefined;
  };
  isError?: boolean;
}
