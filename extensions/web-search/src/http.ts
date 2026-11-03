import { FETCH_ACCEPT_HEADER, USER_AGENT } from "./constants.ts";
import { extractTitle, htmlToText, isHtmlContentType } from "./html.ts";

// --- HTTP fetch helpers ---

export async function fetchUrlOrThrow(
  url: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const init: RequestInit = {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
    signal: signal ?? null,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res;
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
