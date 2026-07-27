import type { ExtensionContext } from "pi";

// --- Types ---

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchArgs {
  query: string;
  maxResults: number;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
}

/**
 * A pluggable search backend. Providers resolve their own credentials from the
 * environment / context and return normalized results, so the tool layer stays
 * provider-agnostic. Add SearXNG (or any other source) by implementing this.
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Short hint shown when the provider is selected but not configured. */
  readonly authHint: string;
  isConfigured(ctx: ExtensionContext): Promise<boolean>;
  search(args: SearchArgs): Promise<SearchResult[]>;
}

export interface BraveRawResult {
  title?: string;
  url?: string;
  description?: string;
}

export interface BraveRawResponse {
  web?: { results?: BraveRawResult[] };
}

export interface SyntheticRawResult {
  url?: string;
  title?: string;
  text?: string;
  published?: string;
}

export interface SyntheticRawResponse {
  results?: SyntheticRawResult[];
}

export interface SearXngRawResult {
  url?: string;
  title?: string;
  content?: string;
}

export interface SearXngRawResponse {
  results?: SearXngRawResult[];
}
