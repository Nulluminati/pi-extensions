import { FETCH_ACCEPT_HEADER, FETCH_TIMEOUT_MS, USER_AGENT } from "./constants.ts";
import { extractTitle, htmlToText, isHtmlContentType } from "./html.ts";

// --- HTTP fetch helpers ---

/**
 * Build an AbortController that fires after FETCH_TIMEOUT_MS and also aborts
 * when the caller's signal fires. All three network call sites share this so
 * timeout/cancellation behavior stays identical across providers.
 */
export function createTimeoutController(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (callerSignal) {
    const onCallerAbort = () => controller.abort();
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

export async function fetchUrlOrThrow(
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const { signal: timeoutSignal, cleanup } = createTimeoutController(signal);
  try {
    const init: RequestInit = {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
      signal: timeoutSignal,
    };
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return res;
  } finally {
    cleanup();
  }
}

export async function extractBodyAsText(
  res: Response,
  contentType: string,
  raw: boolean,
): Promise<{ text: string; title?: string }> {
  const body = await res.text();
  if (!raw && isHtmlContentType(contentType)) {
    const title = extractTitle(body);
    return title !== undefined ? { text: htmlToText(body), title } : { text: htmlToText(body) };
  }
  return { text: body };
}
