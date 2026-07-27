import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { toGuestPath } from "./paths.ts";
import { matchesToolGlob, walkGuestFiles } from "./traversal.ts";

const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function createLineMatcher(
  pattern: string,
  literal: boolean | undefined,
  ignoreCase: boolean | undefined,
) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start =
    params.contextLines > 0
      ? Math.max(0, params.lineIndex - params.contextLines)
      : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return linesTruncated;
}

export async function executeGondolinGrep(
  vm: VM,
  localCwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(localCwd, params.path ?? ".");
  const rootStat = await vm.fs.stat(root, signal ? { signal } : undefined);
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: string;
      try {
        content = await vm.fs.readFile(
          guestPath,
          signal ? { encoding: "utf8", signal } : { encoding: "utf8" },
        );
      } catch {
        return true;
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (
          appendGrepBlock({
            outputLines,
            lines,
            relativePath: displayPath,
            lineIndex: index,
            contextLines,
          })
        ) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0)
    return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
