/** Tool parameter schemas for the web-search tools. */

import { DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS, MIN_MAX_RESULTS } from "./constants.ts";

export const WEB_SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language search query",
    },
    max_results: {
      type: "number",
      description: `Maximum number of results to return (${MIN_MAX_RESULTS}-${MAX_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS})`,
    },
  },
  required: ["query"],
};

export const WEB_FETCH_PARAMS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "HTTP or HTTPS URL to fetch",
    },
    raw: {
      type: "boolean",
      description: "If true, return raw HTML. If false (default), strip HTML to text.",
    },
  },
  required: ["url"],
};
