import { resolve } from "node:path";

// --- Pure Utility Functions ---

export function getExtension(filePath: string): string {
  const clean = cleanPath(filePath);
  const dotIndex = clean.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) return "";
  return clean.slice(dotIndex);
}

// URI / Path conversion

export function pathToUri(filePath: string): string {
  const abs = resolve(filePath);
  const normalized = abs.replace(/\\/g, "/");
  // Windows drive letter: uppercase and use file:///
  const driveMatch = normalized.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (driveMatch && driveMatch[1] !== undefined && driveMatch[2] !== undefined) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2];
    return `file:///${drive}:/${rest}`;
  }
  return `file://${normalized}`;
}

export function uriToPath(uri: string): string {
  // Strip file:// prefix (7 chars)
  let path = uri.slice(7);
  // Decode percent-encoding
  path = decodeURIComponent(path);
  // Windows: remove leading slash before drive letter (/C:/... -> C:/...)
  const driveMatch = path.match(/^\/([a-zA-Z]):(\/.*)$/);
  if (driveMatch && driveMatch[1] !== undefined && driveMatch[2] !== undefined) {
    return `${driveMatch[1].toUpperCase()}:${driveMatch[2]}`;
  }
  return path;
}

export function normalizeUri(uri: string): string {
  let path = uri.slice(7);
  path = decodeURIComponent(path);
  const driveMatch = path.match(/^\/([a-zA-Z]):(\/.*)$/);
  if (driveMatch && driveMatch[1] !== undefined && driveMatch[2] !== undefined) {
    return `file:///${driveMatch[1].toUpperCase()}:${driveMatch[2]}`;
  }
  return uri;
}

// Path helpers

export function cleanPath(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function relativePath(uri: string, rootPath: string): string {
  const absPath = uriToPath(uri);
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  return absPath;
}

export function toZeroIndexed(n: number): number {
  return Math.max(0, n - 1);
}

// Language ID detection

const LANGUAGE_ID_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
  ".zon": "zig",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".lua": "lua",
  ".css": "css",
  ".html": "html",
  ".json": "json",
  ".md": "markdown",
};

export function languageIdForPath(filePath: string): string {
  const ext = getExtension(filePath);
  return LANGUAGE_ID_MAP[ext] ?? "plaintext";
}
