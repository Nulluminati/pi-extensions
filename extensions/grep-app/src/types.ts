// --- Types ---

export interface GrepAppFacetBucket {
  val: string;
  count: number;
}

interface GrepAppFacets {
  count?: number;
  lang?: { buckets?: GrepAppFacetBucket[] };
  repo?: { buckets?: GrepAppFacetBucket[] };
}

export interface GrepAppHit {
  repo?: { raw?: string };
  path?: { raw?: string };
  branch?: { raw?: string };
  total_matches?: { raw?: string };
  content?: { snippet?: string };
}

export interface GrepAppRawResponse {
  facets?: GrepAppFacets;
  hits?: { hits?: GrepAppHit[] };
}

export interface GrepAppFileResult {
  filePath: string;
  branch: string;
  totalMatches: number;
  lineNumbers: number[];
  language: string;
  codeSnippet: string;
}

export interface GrepAppRepoResult {
  repository: string;
  matchesCount: number;
  files: GrepAppFileResult[];
}

export interface GrepAppSearchParams {
  query: string;
  language?: string;
  repo?: string;
  path?: string;
  max_results?: number;
}

export interface GrepAppSearchDetails {
  query: string;
  totalResults: number;
  resultsShown: number;
  repositoriesFound: number;
  topLanguages: GrepAppFacetBucket[];
  topRepositories: GrepAppFacetBucket[];
  results: GrepAppRepoResult[];
  filters?: {
    language?: string | undefined;
    repo?: string | undefined;
    path?: string | undefined;
  };
  isError?: boolean;
}
