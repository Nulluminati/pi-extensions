// --- Constants ---

export const DEFAULT_MAX_RESULTS = 5;

export const MIN_MAX_RESULTS = 1;

export const MAX_MAX_RESULTS = 10;

export const MAX_INLINE_CHARS = 50_000;

export const MAX_FETCH_CONTENT_LENGTH = 1_000_000;

export const FETCH_TIMEOUT_MS = 30_000;

export const TEMP_DIR_PREFIX = "pi-web-search-";

export const TEMP_FILE_NAME = "content.txt";

export const FETCH_PREVIEW_LINE_LIMIT = 15;

export const SEARCH_PREVIEW_RESULT_LIMIT = 5;

export const USER_AGENT = "Mozilla/5.0 (compatible; pi-web-search/1.0)";

export const FETCH_ACCEPT_HEADER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

export const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"];

// Cap each Synthetic result's text excerpt so a single verbose page does not
// dominate the formatted output. Brave descriptions are already short.
export const SYNTHETIC_SNIPPET_MAX_CHARS = 500;

export const PROVIDER_STATE_TYPE = "web-search-provider";

export const DEFAULT_PROVIDER_ID = "synthetic";

export const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";

export const SYNTHETIC_SEARCH_API_URL = "https://api.synthetic.new/v2/search";

export const SEARXNG_SEARCH_PATH = "/search";

export const SEARXNG_URL_ENV = "SEARXNG_URL";

export const SEARXNG_API_KEY_ENV = "SEARXNG_API_KEY";
