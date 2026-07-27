// --- HTML-to-text extraction ---

import { BINARY_CONTENT_TYPE_PREFIXES } from "./constants.ts";

export const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;

export const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;

export const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;

export const BLOCK_CLOSER_REGEX =
  /<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;

export const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;

export const ANY_REMAINING_TAG_REGEX = /<[^>]+>/g;

export const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;

export const NUMERIC_HTML_ENTITY_REGEX = /&#(\d+);/g;

// Hex numeric character reference, e.g. &#x27; (apostrophe). Brave payloads use
// these alongside the decimal form, so both must be handled.
export const HEX_HTML_ENTITY_REGEX = /&#x([0-9a-fA-F]+);/gi;

export const HORIZONTAL_WHITESPACE_RUN = /[ \t]+/g;

export const BLANK_LINE_RUN = /\n{3,}/g;

export function stripNonContentBlocks(html: string): string {
  return html
    .replace(SCRIPT_BLOCK_REGEX, "")
    .replace(STYLE_BLOCK_REGEX, "")
    .replace(NOSCRIPT_BLOCK_REGEX, "");
}

export function convertBlockTagsToNewlines(text: string): string {
  return text.replace(BLOCK_CLOSER_REGEX, "\n").replace(SELF_CLOSING_BR_REGEX, "\n");
}

export function stripRemainingTags(text: string): string {
  return text.replace(ANY_REMAINING_TAG_REGEX, " ");
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(NUMERIC_HTML_ENTITY_REGEX, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(HEX_HTML_ENTITY_REGEX, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function collapseWhitespace(text: string): string {
  return text.replace(HORIZONTAL_WHITESPACE_RUN, " ").replace(BLANK_LINE_RUN, "\n\n");
}

export function htmlToText(html: string): string {
  let text = stripNonContentBlocks(html);
  text = convertBlockTagsToNewlines(text);
  text = stripRemainingTags(text);
  text = decodeHtmlEntities(text);
  text = collapseWhitespace(text);
  return text.trim();
}

export function extractTitle(html: string): string | undefined {
  const match = html.match(TITLE_TAG_REGEX);
  if (!match || match[1] === undefined) return undefined;
  const title = match[1].replace(ANY_REMAINING_TAG_REGEX, "").trim();
  return title || undefined;
}

// --- Content-type helpers ---

export function isHtmlContentType(contentType: string): boolean {
  return contentType.includes("text/html");
}

export function assertTextContentType(contentType: string): void {
  if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.includes(prefix))) {
    throw new Error(
      `Unsupported content type: ${contentType}. web_fetch supports text pages only.`,
    );
  }
}
