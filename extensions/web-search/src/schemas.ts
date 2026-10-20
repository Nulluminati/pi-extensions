/** Tool schemas for the web-search tools. */

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
} as const;

export const WEB_SEARCH_OUTPUT = {
  type: "object",
  properties: {
    query: { type: "string" },
    backend: { type: "string" },
    resultCount: { type: "integer", minimum: 0 },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["title", "url", "snippet"],
      },
    },
    error: { type: "string" },
  },
  required: ["query", "backend", "resultCount", "results"],
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
} as const;
