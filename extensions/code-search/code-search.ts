/**
 * Code Search Extension
 *
 * Pi-native code search across public GitHub repositories using Sourcegraph's
 * public search API. Bypasses MCP entirely — direct HTTP with no API key required.
 */

import type { ExtensionAPI } from "pi";
import { renderCodeSearchResult } from "./src/renderer.ts";
import {
  CODE_SEARCH_OUTPUT,
  CODE_SEARCH_PARAMS,
  createCodeSearchCache,
  executeCodeSearch,
} from "./src/search.ts";

// --- Extension ---

export default async function codeSearchExtension(pi: ExtensionAPI) {
  // Per-instance result cache: identical repeat queries within the TTL skip the network.
  const cache = createCodeSearchCache();

  pi.registerTool({
    name: "code_search",
    label: "Sourcegraph Code Search",
    description:
      "Search code across millions of public GitHub repositories using Sourcegraph. Returns matching files, line numbers, and code snippets with optional filters for language, repository, and path.",
    promptSnippet: "Search public GitHub code for patterns, examples, or API usage",
    promptGuidelines: [
      "Use code_search when you need real-world code examples or want to see how an API, function, or pattern is used in open source.",
      "Keep queries focused. Specific patterns return more useful snippets than broad keywords.",
      "Filter by language or repo when the answer depends on a particular ecosystem or project.",
      "code_search covers public GitHub repositories only; private or non-GitHub code is not indexed.",
    ],
    parameters: CODE_SEARCH_PARAMS,
    outputSchema: CODE_SEARCH_OUTPUT,
    renderResult: renderCodeSearchResult,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      executeCodeSearch(toolCallId, params, signal, onUpdate, ctx, cache),
  });
}
