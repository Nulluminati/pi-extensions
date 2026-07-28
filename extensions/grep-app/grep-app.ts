/**
 * Grep.app Extension
 *
 * Pi-native code search across public GitHub repositories using the grep.app API.
 * Bypasses MCP entirely — direct HTTP with no API key required.
 */

import type { ExtensionAPI } from "pi";
import { renderGrepAppResult } from "./src/renderer.ts";
import { executeGrepAppSearch, GREP_SEARCH_PARAMS } from "./src/search.ts";

// --- Extension ---

export default async function grepAppExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "grep_search",
    label: "Grep.app Code Search",
    description:
      "Search code across millions of public GitHub repositories using grep.app. Returns matching files, line numbers, and code snippets with optional filters for language, repository, and path.",
    promptSnippet: "Search public GitHub code for patterns, examples, or API usage",
    promptGuidelines: [
      "Use grep_search when you need real-world code examples or want to see how an API, function, or pattern is used in open source.",
      "Keep queries focused. Specific patterns return more useful snippets than broad keywords.",
      "Filter by language or repo when the answer depends on a particular ecosystem or project.",
      "grep.app searches public GitHub repositories only; private or non-GitHub code is not indexed.",
    ],
    parameters: GREP_SEARCH_PARAMS,
    renderResult: renderGrepAppResult,
    execute: executeGrepAppSearch,
  });
}
