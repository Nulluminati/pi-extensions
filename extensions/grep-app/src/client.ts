import type { GrepAppRawResponse, GrepAppSearchParams } from "./types.ts";

const GREP_APP_API_URL = "https://grep.app/api/search";
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; pi-grep-app/1.0)";

export function buildSearchUrl(params: GrepAppSearchParams): string {
  const url = new URL(GREP_APP_API_URL);
  url.searchParams.set("q", params.query);

  if (params.language) {
    url.searchParams.set("f.lang", params.language.trim());
  }
  if (params.repo) {
    url.searchParams.set("f.repo", params.repo.trim());
  }
  if (params.path) {
    url.searchParams.set("f.path", params.path.trim());
  }

  return url.toString();
}

export async function fetchGrepApp(
  url: string,
  signal: AbortSignal | undefined,
): Promise<GrepAppRawResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  if (signal) {
    const onCallerAbort = () => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error("Rate limit exceeded. Please wait before making another request.");
    }

    if (!response.ok) {
      throw new Error(`grep.app API error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as GrepAppRawResponse;
    if (!data || typeof data !== "object") {
      throw new Error("grep.app returned an invalid response.");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}
