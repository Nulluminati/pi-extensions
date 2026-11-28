// --- HTML-to-text extraction ---

import { BINARY_CONTENT_TYPE_PREFIXES } from "./constants.ts";

export const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;

export const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;

export const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;

export const BLOCK_CLOSER_REGEX =
  /<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;

export const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;

// A "<" starts a tag only when a letter, "/" plus a letter, "!" (comment or
// doctype), or "?" follows it, as in the HTML tokenizer. Any other "<" (a
// comparison such as "a < b", "<=", "<3") stays as text. The tag body excludes
// "<", so the scan for an unclosed tag stops at the next "<".
export const ANY_REMAINING_TAG_REGEX = /<(?:!--[\s\S]*?--|\/?[a-zA-Z][^<>]*|[!?][^<>]*)>/g;

export const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;

// Named, decimal, and hex character references, e.g. &#x27; (apostrophe). Brave
// payloads use hex alongside the decimal form, so both must be handled. One
// combined pass decodes each reference exactly once, so double-encoded input
// such as "&amp;lt;" becomes "&lt;", never "<". Named references outside
// NAMED_HTML_ENTITIES stay as literal text.
export const HTML_ENTITY_REGEX = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

// The named references that pages and search snippets commonly use. This is not
// the full HTML5 table.
export const NAMED_HTML_ENTITIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201C",
    rdquo: "\u201D",
    ndash: "\u2013",
    mdash: "\u2014",
    hellip: "\u2026",
    copy: "\u00A9",
    reg: "\u00AE",
    trade: "\u2122",
    laquo: "\u00AB",
    raquo: "\u00BB",
    times: "\u00D7",
    middot: "\u00B7",
    deg: "\u00B0",
    euro: "\u20AC",
  }),
);

const REPLACEMENT_CHARACTER = "\uFFFD";

// Follows the HTML parser: NUL, surrogates, and values above U+10FFFF become
// U+FFFD instead of a broken or truncated character.
function decodeCodePoint(codePoint: number): string {
  const isInvalid =
    codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
  return isInvalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(codePoint);
}

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
  return text.replace(HTML_ENTITY_REGEX, (entity: string) => {
    if (entity[1] !== "#") {
      return NAMED_HTML_ENTITIES.get(entity.slice(1, -1)) ?? entity;
    }
    // Numeric reference: decimal (&#39;) or hex (&#x27;).
    const isHex = entity[2]?.toLowerCase() === "x";
    const digits = isHex ? entity.slice(3, -1) : entity.slice(2, -1);
    return decodeCodePoint(parseInt(digits, isHex ? 16 : 10));
  });
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
  const title = decodeHtmlEntities(match[1].replace(ANY_REMAINING_TAG_REGEX, "")).trim();
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
