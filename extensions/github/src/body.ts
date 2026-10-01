import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { sanitizeGitHubText } from "./text.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

// Keep code spans and autolinks intact. Match quoted attributes before tag closers.
const HTML_OR_LITERAL =
  /(`+)[\s\S]*?\1(?!`)|<https?:\/\/[^\s>]+>|<[^\s<>]+@[^\s<>]+>|<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\2\s*>|<\/?([a-z][a-z0-9-]*)(?:\s+(?:"[^"]*"|'[^']*'|[^'"<>])*)?\s*\/?>/gi;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name] ?? entity;
    const hex = name[1]?.toLowerCase() === "x";
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : "�";
  });
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/** Convert GitHub HTML wrappers to Markdown without treating source-code examples as HTML. */
function readableMarkdown(source: string): string {
  const links: string[] = [];
  let pre = false;

  function convert(chunk: string): string {
    let result = "";
    let position = 0;
    for (const match of chunk.matchAll(HTML_OR_LITERAL)) {
      result += decodeEntities(chunk.slice(position, match.index));
      position = match.index + match[0].length;
      const [raw, code, hidden, tagName] = match;
      if (code || /^<(?:https?:\/\/|[^\s<>]+@)/i.test(raw)) {
        result += raw;
        continue;
      }
      if (hidden || raw.startsWith("<!--")) continue;
      const tag = tagName?.toLowerCase();
      const closing = raw.startsWith("</");
      if (pre && tag !== "pre" && tag !== "code") {
        result += raw;
        continue;
      }
      if (tag === "a") {
        if (closing) {
          const href = links.pop();
          result += href ? `](${href.replace(/[()\\]/g, "\\$&")})` : "";
        } else {
          const href = attribute(raw, "href");
          const safeHref = /^(?:https?:\/\/|mailto:|#)/i.test(href) ? href : "";
          links.push(safeHref);
          result += safeHref ? "[" : "";
        }
      } else if (tag === "img") result += attribute(raw, "alt");
      else if (tag === "summary") result += closing ? "**\n\n" : "\n\n**";
      else if (tag && /^h[1-6]$/.test(tag))
        result += closing ? "\n\n" : `\n\n${"#".repeat(Number(tag[1]))} `;
      else if (tag === "strong" || tag === "b") result += "**";
      else if (tag === "em" || tag === "i") result += "*";
      else if (tag === "pre") {
        pre = !closing;
        result += "\n```\n";
      } else if (tag === "code") result += pre ? "" : "`";
      else if (tag === "li") result += closing ? "\n" : "\n- ";
      else if (tag === "br") result += "\n";
      else if (tag === "td" || tag === "th") result += closing ? " | " : "";
      else if (tag && /^(?:p|div|blockquote|ul|ol|table|tr|section|article|hr)$/.test(tag))
        result += "\n\n";
    }
    return (result + decodeEntities(chunk.slice(position))).replace(/\n{3,}/g, "\n\n");
  }

  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  function flush() {
    if (prose.length > 0) output.push(convert(prose.join("\n")));
    prose = [];
  }
  for (const line of source.split("\n")) {
    const marker = /^\s*(?:>\s*)*(?:[-*+]\s+)?(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      output.push(line);
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trimEnd().endsWith(marker)
      )
        fence = undefined;
    } else if (marker || /^(?: {4}|\t)/.test(line)) {
      flush();
      output.push(line);
      if (marker) fence = marker;
    } else prose.push(line);
  }
  flush();
  return output.join("\n").trim();
}

/** Only display text changes. The client and agent handoff retain the original GitHub content. */
export function renderGitHubBody(text: string, width: number): string[] {
  const markdown = sanitizeGitHubText(readableMarkdown(sanitizeGitHubText(text)));
  return new Markdown(markdown, 0, 0, getMarkdownTheme()).render(width);
}
