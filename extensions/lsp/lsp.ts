/**
 * LSP Extension
 *
 * Language-agnostic code intelligence via the Language Server Protocol.
 * Config-driven: users define LSP servers in JSON config files,
 * and the extension auto-detects servers by file extension.
 */

// --- Imports ---

import { execSync, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "pi";
import { Type } from "typebox";

// --- Constants ---

const REQUEST_TIMEOUT = 30_000;
const SHUTDOWN_TIMEOUT = 5_000;
const DIAGNOSTIC_WAIT_TIMEOUT = 10_000;
const RECENTLY_INITIALIZED_WINDOW = 30_000;
const RETRY_MAX_ATTEMPTS = 2;
const RETRY_DELAY = 2_000;
const STDERR_LOG_BUFFER_SIZE = 100;
const WORKSPACE_SYMBOLS_LIMIT = 50;
const COMMAND_CHECK_TIMEOUT = 5_000;
const NPX_CHECK_TIMEOUT = 15_000;
const STATUS_KEY = "lsp";

// Status-bar indicator: a Nerd Font code-braces icon in a distinct hue with a
// greyed label, matching the cross-extension footer convention. The codepoint
// is built explicitly so the PUA glyph survives transports that strip literals.
export const STATUS_ICON = String.fromCodePoint(0xf0169); // nf-md-code-braces
export const ICON_COLOR = "mdLink";
export const TEXT_COLOR = "muted";

const GLOBAL_CONFIG_DIR_SUFFIX = ".pi/agent/extensions/lsp";
const GLOBAL_CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PATH = ".pi/lsp.json";
const CODEACTIONS_END_CHAR = Number.MAX_SAFE_INTEGER;

const LSP_OPERATIONS = [
  "diagnostics",
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "documentSymbol",
  "workspaceSymbol",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeActions",
] as const;

type LspOperation = (typeof LSP_OPERATIONS)[number];

const POSITION_OPS: ReadonlySet<LspOperation> = new Set([
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeActions",
]);

const FILE_OPS: ReadonlySet<LspOperation> = new Set(["diagnostics", "documentSymbol"]);

const QUERY_OPS: ReadonlySet<LspOperation> = new Set(["workspaceSymbol"]);

const RETRYABLE_OPS: ReadonlySet<LspOperation> = new Set([
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "documentSymbol",
  "workspaceSymbol",
]);

// --- Types ---

interface ResolvedServerConfig {
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  env: Record<string, string>;
  initializationOptions: Record<string, unknown>;
}

interface LoadedConfig {
  servers: ResolvedServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

interface LspServerUserConfig {
  command?: string[];
  extensions?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

interface LspConfigFile {
  lsp?: false | Record<string, LspServerUserConfig>;
}

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface Location {
  uri: string;
  range: Range;
}

interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  codeDescription?: { href: string };
  relatedInformation?: Array<{
    location: Location;
    message: string;
  }>;
}

interface Hover {
  contents: unknown;
  range?: Range;
}

interface DocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

interface CodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: { title: string; command: string; arguments?: unknown[] };
}

interface WorkspaceEdit {
  changes?: Record<string, Array<{ range: Range; newText: string }>>;
  documentChanges?: unknown[];
}

interface PendingDiagnostic {
  resolve: (diags: Diagnostic[]) => void;
  timer: NodeJS.Timeout;
}

interface OpenDocument {
  version: number;
  text: string;
}

// --- Pure Utility Functions ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExtension(filePath: string): string {
  const clean = cleanPath(filePath);
  const dotIndex = clean.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) return "";
  return clean.slice(dotIndex);
}

// URI / Path conversion

function pathToUri(filePath: string): string {
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

function uriToPath(uri: string): string {
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

function normalizeUri(uri: string): string {
  let path = uri.slice(7);
  path = decodeURIComponent(path);
  const driveMatch = path.match(/^\/([a-zA-Z]):(\/.*)$/);
  if (driveMatch && driveMatch[1] !== undefined && driveMatch[2] !== undefined) {
    return `file:///${driveMatch[1].toUpperCase()}:${driveMatch[2]}`;
  }
  return uri;
}

// Path helpers

function cleanPath(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function relativePath(uri: string, rootPath: string): string {
  const absPath = uriToPath(uri);
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  return absPath;
}

function toZeroIndexed(n: number): number {
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

function languageIdForPath(filePath: string): string {
  const ext = getExtension(filePath);
  return LANGUAGE_ID_MAP[ext] ?? "plaintext";
}

// Formatting helpers

function severityLabel(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "ERROR";
    case 2:
      return "WARN";
    case 3:
      return "INFO";
    case 4:
      return "HINT";
    default:
      return "UNKNOWN";
  }
}

function symbolKindLabel(kind: number): string {
  switch (kind) {
    case 1:
      return "file";
    case 2:
      return "module";
    case 3:
      return "namespace";
    case 4:
      return "package";
    case 5:
      return "class";
    case 6:
      return "method";
    case 7:
      return "property";
    case 8:
      return "field";
    case 9:
      return "constructor";
    case 10:
      return "enum";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 13:
      return "variable";
    case 14:
      return "constant";
    case 15:
      return "string";
    case 16:
      return "number";
    case 17:
      return "boolean";
    case 18:
      return "array";
    case 19:
      return "object";
    case 20:
      return "key";
    case 21:
      return "null";
    case 22:
      return "enum-member";
    case 23:
      return "struct";
    case 24:
      return "event";
    case 25:
      return "operator";
    case 26:
      return "type-param";
    default:
      return `kind(${kind})`;
  }
}

function fmtRange(range: Range): string {
  const startLine = range.start.line + 1;
  const startChar = range.start.character + 1;
  const endLine = range.end.line + 1;
  const endChar = range.end.character + 1;
  if (range.start.line === range.end.line) {
    return `line ${startLine}:${startChar}-${endChar}`;
  }
  return `lines ${startLine}:${startChar}-${endLine}:${endChar}`;
}

// LSP response formatters

function formatDiagnostics(
  filePath: string,
  groups: Array<{ source: string; diagnostics: Diagnostic[] }>,
): string {
  const allDiags = groups.flatMap((g) => g.diagnostics);

  if (allDiags.length === 0) {
    return `${filePath}: No diagnostics — all clean ✓`;
  }

  const errors = allDiags.filter((d) => d.severity === 1 || d.severity === undefined).length;
  const warnings = allDiags.filter((d) => d.severity === 2).length;
  const infoHint = allDiags.filter((d) => d.severity === 3 || d.severity === 4).length;

  const lines: string[] = [
    `${filePath}: ${errors} error(s), ${warnings} warning(s), ${infoHint} info/hint(s)`,
  ];

  let num = 1;
  for (const group of groups) {
    lines.push("");
    lines.push(`[${group.source}]`);
    for (const diag of group.diagnostics) {
      const sev = severityLabel(diag.severity);
      const range = fmtRange(diag.range);
      const src = diag.source ? ` [${diag.source}]` : "";
      const code = diag.code !== undefined && diag.code !== null ? ` (${diag.code})` : "";
      lines.push(`${num}. ${sev} ${range}${src}${code}`);
      lines.push(`  ${diag.message}`);
      if (diag.codeDescription?.href) {
        lines.push(`  Docs: ${diag.codeDescription.href}`);
      }
      num++;
    }
  }

  return lines.join("\n");
}

function formatHoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (contents && typeof contents === "object") {
    const obj = contents as Record<string, unknown>;
    if ("kind" in obj && "value" in obj) {
      // MarkupContent
      return String(obj.value);
    }
    if (Array.isArray(obj)) {
      return (obj as unknown[])
        .map((item: unknown) => {
          if (typeof item === "string") return item;
          if (
            item &&
            typeof item === "object" &&
            "language" in (item as object) &&
            "value" in (item as object)
          ) {
            const i = item as { language: string; value: string };
            return `\`\`\`${i.language}\n${i.value}\n\`\`\``;
          }
          return JSON.stringify(item);
        })
        .join("\n\n");
    }
  }
  return JSON.stringify(contents);
}

function formatHover(
  hover: Hover | null,
  filePath: string,
  line: number,
  character: number,
): string {
  if (!hover) {
    return `No hover information at ${filePath}:${line}:${character}`;
  }
  const contents = formatHoverContents(hover.contents);
  return `Hover at ${filePath}:${line}:${character}:\n\n${contents}`;
}

function formatLocations(
  locations: Location[],
  kind: string,
  filePath: string,
  line: number,
  character: number,
  rootPath: string,
): string {
  const queryPos = `${filePath}:${line}:${character}`;
  if (locations.length === 0) {
    return `No ${kind} found for symbol at ${queryPos}`;
  }
  const entries = locations
    .map((loc) => {
      const rp = relativePath(loc.uri, rootPath);
      return `${rp}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
    })
    .map((entry, i) => `${i + 1}. ${entry}`)
    .join("\n");
  return `${kind} for symbol at ${queryPos} (${locations.length} result(s)):\n\n${entries}`;
}

function formatDocumentSymbols(result: unknown[], filePath: string, rootPath: string): string {
  if (result.length === 0) {
    return `No symbols found in ${filePath}`;
  }

  // Check if hierarchical (DocumentSymbol) or flat (SymbolInformation)
  const first = result[0] as Record<string, unknown>;
  if ("location" in first) {
    // SymbolInformation[]
    const symbols = result as SymbolInformation[];
    const entries = symbols
      .map((s, i) => {
        const rp = relativePath(s.location.uri, rootPath);
        const pos = `${s.location.range.start.line + 1}:${s.location.range.start.character + 1}`;
        const container = s.containerName ? ` — in ${s.containerName}` : "";
        return `${i + 1}. ${s.name} (${symbolKindLabel(s.kind)}) ${rp}:${pos}${container}`;
      })
      .join("\n");
    return `Symbols in ${filePath} (${symbols.length}):\n\n${entries}`;
  }

  // DocumentSymbol[] (hierarchical)
  const symbols = result as DocumentSymbol[];
  const lines: string[] = [];
  function renderTree(syms: DocumentSymbol[], indent: number): void {
    const prefix = "  ".repeat(indent);
    for (const sym of syms) {
      const kind = symbolKindLabel(sym.kind);
      const pos = `${sym.selectionRange.start.line + 1}:${sym.selectionRange.start.character + 1}`;
      const detail = sym.detail ? ` ${sym.detail}` : "";
      lines.push(`${prefix}${sym.name} (${kind}) ${pos}${detail}`);
      if (sym.children && sym.children.length > 0) {
        renderTree(sym.children, indent + 1);
      }
    }
  }
  renderTree(symbols, 0);
  return `Symbols in ${filePath} (${symbols.length} top-level):\n\n${lines.join("\n")}`;
}

function formatWorkspaceSymbols(
  symbols: SymbolInformation[],
  query: string,
  rootPath: string,
): string {
  if (symbols.length === 0) {
    return `No workspace symbols matching "${query}"`;
  }

  const total = symbols.length;
  const shown = symbols.slice(0, WORKSPACE_SYMBOLS_LIMIT);
  const entries = shown
    .map((s, i) => {
      const rp = relativePath(s.location.uri, rootPath);
      const pos = `${s.location.range.start.line + 1}:${s.location.range.start.character + 1}`;
      const container = s.containerName ? ` — in ${s.containerName}` : "";
      return `${i + 1}. ${s.name} (${symbolKindLabel(s.kind)}) ${rp}:${pos}${container}`;
    })
    .join("\n");

  let result = `Workspace symbols matching "${query}" (${total}):\n\n${entries}`;
  if (total > WORKSPACE_SYMBOLS_LIMIT) {
    result += `\n\n(showing ${WORKSPACE_SYMBOLS_LIMIT} of ${total})`;
  }
  return result;
}

function formatCallHierarchy(
  items: CallHierarchyItem[],
  filePath: string,
  line: number,
  character: number,
  rootPath: string,
): string {
  const queryPos = `${filePath}:${line}:${character}`;
  if (items.length === 0) {
    return `No call hierarchy item at ${queryPos}`;
  }
  const entries = items
    .map((item, i) => {
      const rp = relativePath(item.uri, rootPath);
      const pos = `${item.range.start.line + 1}`;
      const detail = item.detail ? ` ${item.detail}` : "";
      return `${i + 1}. ${item.name} (${symbolKindLabel(item.kind)}) ${rp}:${pos}${detail}`;
    })
    .join("\n");
  return `Call hierarchy at ${queryPos}:\n\n${entries}`;
}

function formatIncomingCalls(
  calls: CallHierarchyIncomingCall[],
  target: CallHierarchyItem,
  rootPath: string,
): string {
  if (calls.length === 0) {
    return `No incoming calls to ${target.name}`;
  }
  const entries = calls
    .map((call, i) => {
      const from = call.from;
      const rp = relativePath(from.uri, rootPath);
      const pos = `${from.range.start.line + 1}`;
      const detail = from.detail ? ` ${from.detail}` : "";
      return `${i + 1}. ${from.name} (${symbolKindLabel(from.kind)}) ${rp}:${pos}${detail}`;
    })
    .join("\n");
  return `Incoming calls to ${target.name} (${calls.length}):\n\n${entries}`;
}

function formatOutgoingCalls(
  calls: CallHierarchyOutgoingCall[],
  source: CallHierarchyItem,
  rootPath: string,
): string {
  if (calls.length === 0) {
    return `No outgoing calls from ${source.name}`;
  }
  const entries = calls
    .map((call, i) => {
      const to = call.to;
      const rp = relativePath(to.uri, rootPath);
      const pos = `${to.range.start.line + 1}`;
      const detail = to.detail ? ` ${to.detail}` : "";
      return `${i + 1}. ${to.name} (${symbolKindLabel(to.kind)}) ${rp}:${pos}${detail}`;
    })
    .join("\n");
  return `Outgoing calls from ${source.name} (${calls.length}):\n\n${entries}`;
}

function formatCodeActions(actions: CodeAction[], filePath: string, line: number): string {
  const displayLine = line + 1;
  if (actions.length === 0) {
    return `No code actions available at ${filePath}:${displayLine}`;
  }
  const entries = actions
    .map((action, i) => {
      const kind = action.kind ? ` [${action.kind}]` : "";
      const preferred = action.isPreferred ? " ★ preferred" : "";
      let editSummary = "";
      if (action.edit?.changes) {
        const changes = action.edit.changes;
        const files = Object.keys(changes);
        const totalEdits = files.reduce((sum, f) => sum + (changes[f]?.length ?? 0), 0);
        editSummary = `\n   Changes: ${totalEdits} edits across ${files.length} files`;
      }
      return `${i + 1}. ${action.title}${kind}${preferred}${editSummary}`;
    })
    .join("\n");
  return `Code actions at ${filePath}:${displayLine} (${actions.length} available):\n\n${entries}`;
}

// Operation capability mapping

function operationCapability(op: LspOperation): string {
  switch (op) {
    case "diagnostics":
      return "textDocumentSync";
    case "hover":
      return "hoverProvider";
    case "goToDefinition":
      return "definitionProvider";
    case "findReferences":
      return "referencesProvider";
    case "goToImplementation":
      return "implementationProvider";
    case "documentSymbol":
      return "documentSymbolProvider";
    case "workspaceSymbol":
      return "workspaceSymbolProvider";
    case "prepareCallHierarchy":
    case "incomingCalls":
    case "outgoingCalls":
      return "callHierarchyProvider";
    case "codeActions":
      return "codeActionProvider";
  }
}

function normalizeLocations(result: unknown): Location[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map((item: unknown) => {
      const obj = item as Record<string, unknown>;
      if ("targetUri" in obj) {
        // LocationLink
        return {
          uri: String(obj.targetUri),
          range: (obj.targetSelectionRange ?? obj.targetRange) as Range,
        };
      }
      return item as Location;
    });
  }
  const obj = result as Record<string, unknown>;
  if ("uri" in obj) return [result as Location];
  if ("targetUri" in obj) {
    return [
      {
        uri: String(obj.targetUri),
        range: (obj.targetSelectionRange ?? obj.targetRange) as Range,
      },
    ];
  }
  return [];
}

// --- LspConnection (JSON-RPC over stdio) ---

class LspConnection {
  private process: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  public onNotification: ((method: string, params: unknown) => void) | null = null;
  public onServerRequest:
    | ((method: string, params: unknown, id: number) => Promise<unknown>)
    | null = null;
  private stderrLogs: string[] = [];
  private disposed = false;
  public onExit: (() => void) | null = null;

  constructor(
    private command: string,
    private args: string[],
    private rootPath: string,
    private env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const isWin = process.platform === "win32";
    this.process = spawn(this.command, this.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
      shell: isWin,
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.drainBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.stderrLogs.push(line);
        if (this.stderrLogs.length > STDERR_LOG_BUFFER_SIZE) {
          this.stderrLogs.shift();
        }
      }
    });

    this.process.on("exit", () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Server process exited"));
      }
      this.pending.clear();
      this.process = null;
      this.onExit?.();
    });
  }

  private drainBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match || match[1] === undefined) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;

      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // Skip malformed JSON
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const hasId = "id" in message;
    const hasMethod = "method" in message;

    if (hasId && hasMethod) {
      // Server request
      const id = message.id as number;
      const method = message.method as string;
      const params = message.params;
      if (this.onServerRequest) {
        this.onServerRequest(method, params, id)
          .then((result) => this.sendResponse(id, result))
          .catch(() => this.sendError(id, -32603, "Internal error"));
      } else {
        this.sendResponse(id, null);
      }
    } else if (hasId && !hasMethod) {
      // Response
      const id = message.id as number;
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if ("error" in message) {
          const err = message.error as Record<string, unknown> | undefined;
          entry.reject(new Error(typeof err?.message === "string" ? err.message : "LSP error"));
        } else {
          entry.resolve(message.result);
        }
      }
    } else if (hasMethod && !hasId) {
      // Notification
      this.onNotification?.(message.method as string, message.params);
    }
  }

  sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const timeout = timeoutMs ?? REQUEST_TIMEOUT;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendResponse(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    const body = JSON.stringify(message);
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      await this.sendRequest("shutdown", undefined, SHUTDOWN_TIMEOUT);
    } catch {
      // Best-effort shutdown
    }

    this.sendNotification("exit");

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection disposed"));
    }
    this.pending.clear();
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  getStderrLogs(): string[] {
    return [...this.stderrLogs];
  }
}

// --- LspClient ---

class LspClient {
  private connection: LspConnection;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private capabilities: Record<string, unknown> = {};
  private initTimestamp = 0;
  private openDocuments = new Map<string, OpenDocument>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private pendingDiagnostics = new Map<string, PendingDiagnostic>();
  private invalidatedUris = new Set<string>();

  constructor(
    private serverConfig: ResolvedServerConfig,
    private rootPath: string,
  ) {
    this.connection = new LspConnection(
      serverConfig.command,
      serverConfig.args,
      rootPath,
      serverConfig.env,
    );

    this.connection.onNotification = (method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        this.handleDiagnostics(params as { uri: string; diagnostics: Diagnostic[] });
      }
    };

    this.connection.onServerRequest = async () => {
      return null;
    };

    this.connection.onExit = () => {
      this.initialized = false;
      this.initializePromise = null;
      this.openDocuments.clear();
    };
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.doInitialize();
    try {
      await this.initializePromise;
    } catch (err) {
      this.initializePromise = null;
      throw err;
    }
  }

  private async doInitialize(): Promise<void> {
    await this.connection.start();

    const rootUri = pathToUri(this.rootPath);
    const rootName = basename(this.rootPath);

    const result = (await this.connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.rootPath,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            codeDescriptionSupport: true,
          },
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          definition: {
            linkSupport: false,
          },
          references: {},
          implementation: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source"],
              },
            },
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          callHierarchy: {},
          synchronization: {
            didSave: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          symbol: {},
        },
      },
      workspaceFolders: [{ uri: rootUri, name: rootName }],
      initializationOptions: this.serverConfig.initializationOptions,
    })) as Record<string, unknown> | null;

    this.capabilities = (result?.capabilities ?? {}) as Record<string, unknown>;
    this.initialized = true;
    this.initTimestamp = Date.now();

    this.connection.sendNotification("initialized", {});
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isRecentlyInitialized(): boolean {
    return this.initTimestamp > 0 && Date.now() - this.initTimestamp < RECENTLY_INITIALIZED_WINDOW;
  }

  hasCapability(capability: string): boolean {
    if (capability === "textDocumentSync") {
      return !!this.capabilities.textDocumentSync;
    }
    return !!this.capabilities[capability];
  }

  getServerName(): string {
    return this.serverConfig.name;
  }

  // Document management

  async openDocument(filePath: string): Promise<void> {
    const clean = cleanPath(filePath);
    const absPath = resolve(this.rootPath, clean);
    const uri = pathToUri(absPath);

    if (this.openDocuments.has(uri)) return;

    const text = await readFile(absPath, "utf-8");
    const languageId = languageIdForPath(clean);

    this.openDocuments.set(uri, { version: 1, text });
    this.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.connection.sendNotification("textDocument/didSave", {
      textDocument: { uri },
    });
  }

  async resyncDocument(filePath: string): Promise<string> {
    const clean = cleanPath(filePath);
    const absPath = resolve(this.rootPath, clean);
    const uri = pathToUri(absPath);

    // Ensure open first
    if (!this.openDocuments.has(uri)) {
      await this.openDocument(filePath);
    }

    const doc = this.openDocuments.get(uri);
    if (!doc) return uri;

    const text = await readFile(absPath, "utf-8");
    const newVersion = doc.version + 1;

    this.openDocuments.set(uri, { version: newVersion, text });
    this.invalidatedUris.add(uri);
    this.diagnostics.delete(uri);

    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: newVersion },
      contentChanges: [{ text }],
    });
    this.connection.sendNotification("textDocument/didSave", {
      textDocument: { uri },
    });

    return uri;
  }

  // Diagnostics

  private handleDiagnostics(params: { uri: string; diagnostics: Diagnostic[] }): void {
    const uri = normalizeUri(params.uri);
    const diags = params.diagnostics ?? [];

    this.diagnostics.set(uri, diags);

    const pending = this.pendingDiagnostics.get(uri);
    if (pending) {
      if (diags.length > 0) {
        clearTimeout(pending.timer);
        this.pendingDiagnostics.delete(uri);
        this.invalidatedUris.delete(uri);
        pending.resolve(diags);
      } else if (!this.invalidatedUris.has(uri)) {
        clearTimeout(pending.timer);
        this.pendingDiagnostics.delete(uri);
        pending.resolve(diags);
      }
      // Empty diagnostics for invalidated URI: don't resolve (stale clearing)
    } else if (diags.length > 0) {
      this.invalidatedUris.delete(uri);
    }
  }

  async waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
    // If we already have non-stale diagnostics, return them
    if (this.diagnostics.has(uri) && !this.invalidatedUris.has(uri)) {
      return this.diagnostics.get(uri) ?? [];
    }

    // Clear any existing pending
    const existing = this.pendingDiagnostics.get(uri);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve([]);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDiagnostics.delete(uri);
        this.invalidatedUris.delete(uri);
        resolve(this.diagnostics.get(uri) ?? []);
      }, DIAGNOSTIC_WAIT_TIMEOUT);

      this.pendingDiagnostics.set(uri, { resolve, timer });
    });
  }

  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  // LSP operations

  async hover(uri: string, position: Position): Promise<Hover | null> {
    return (await this.connection.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position,
    })) as Hover | null;
  }

  async definition(uri: string, position: Position): Promise<unknown> {
    return await this.connection.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position,
    });
  }

  async references(uri: string, position: Position): Promise<Location[] | null> {
    return (await this.connection.sendRequest("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    })) as Location[] | null;
  }

  async implementation(uri: string, position: Position): Promise<unknown> {
    return await this.connection.sendRequest("textDocument/implementation", {
      textDocument: { uri },
      position,
    });
  }

  async documentSymbol(uri: string): Promise<unknown[]> {
    const result = await this.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return (result as unknown[]) ?? [];
  }

  async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
    const result = await this.connection.sendRequest("workspace/symbol", { query });
    return (result as SymbolInformation[] | null) ?? [];
  }

  async prepareCallHierarchy(uri: string, position: Position): Promise<CallHierarchyItem[] | null> {
    return (await this.connection.sendRequest("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position,
    })) as CallHierarchyItem[] | null;
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[] | null> {
    return (await this.connection.sendRequest("callHierarchy/incomingCalls", { item })) as
      | CallHierarchyIncomingCall[]
      | null;
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
    return (await this.connection.sendRequest("callHierarchy/outgoingCalls", { item })) as
      | CallHierarchyOutgoingCall[]
      | null;
  }

  async codeActions(uri: string, range: Range, diags: Diagnostic[]): Promise<CodeAction[]> {
    const result = await this.connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: {
        diagnostics: diags,
        triggerKind: 1,
      },
    });
    return (result as CodeAction[] | null) ?? [];
  }

  // Lifecycle

  async shutdown(): Promise<void> {
    try {
      await this.connection.dispose();
    } catch {
      // Best-effort
    }
    this.initialized = false;
    this.initializePromise = null;
    this.openDocuments.clear();
    this.diagnostics.clear();
    this.pendingDiagnostics.clear();
    this.invalidatedUris.clear();
  }

  isRunning(): boolean {
    return this.connection.isRunning();
  }

  getUriForFile(filePath: string): string {
    const absPath = resolve(this.rootPath, cleanPath(filePath));
    return pathToUri(absPath);
  }
}

// --- Config Loading ---

function checkCommandAvailable(command: string): "global" | "npx" | "not_found" {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";

  try {
    execSync(`${whichCmd} ${command}`, {
      timeout: COMMAND_CHECK_TIMEOUT,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return "global";
  } catch {
    // Not found globally
  }

  try {
    execSync(`npx --yes ${command} --version`, {
      timeout: NPX_CHECK_TIMEOUT,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return "npx";
  } catch {
    // Not found via npx
  }

  return "not_found";
}

function resolveServerConfig(
  name: string,
  userConfig: LspServerUserConfig,
): ResolvedServerConfig | null {
  const command = userConfig.command;
  if (!command || command.length === 0) return null;

  const extensions = userConfig.extensions;
  if (!extensions || extensions.length === 0) return null;

  const executable = command[0];
  if (!executable) return null;
  const cmdArgs = command.slice(1);

  const availability = checkCommandAvailable(executable);

  if (availability === "not_found") return null;

  let resolvedCommand: string;
  let resolvedArgs: string[];

  if (availability === "npx") {
    resolvedCommand = "npx";
    resolvedArgs = ["--yes", executable, ...cmdArgs];
  } else {
    resolvedCommand = executable;
    resolvedArgs = cmdArgs;
  }

  return {
    name,
    command: resolvedCommand,
    args: resolvedArgs,
    extensions,
    env: userConfig.env ?? {},
    initializationOptions: userConfig.initialization ?? {},
  };
}

function mergeConfigs(
  global: false | Record<string, LspServerUserConfig> | undefined,
  project: false | Record<string, LspServerUserConfig> | undefined,
): Record<string, LspServerUserConfig> {
  if (global === false || project === false) return {};

  const merged: Record<string, LspServerUserConfig> = {};

  if (global && typeof global === "object") {
    for (const [key, value] of Object.entries(global)) {
      if (value.disabled) continue;
      merged[key] = value;
    }
  }

  if (project && typeof project === "object") {
    for (const [key, value] of Object.entries(project)) {
      if (value.disabled) {
        delete merged[key];
        continue;
      }
      // Deep merge env
      const existing = merged[key];
      if (existing) {
        merged[key] = {
          ...existing,
          ...value,
          env: { ...existing.env, ...value.env },
        };
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(rootPath: string): Promise<LoadedConfig> {
  const globalDir = join(homedir(), GLOBAL_CONFIG_DIR_SUFFIX);
  const globalPath = join(globalDir, GLOBAL_CONFIG_FILENAME);
  const projectPath = join(rootPath, PROJECT_CONFIG_PATH);

  let globalConfig: LspConfigFile | null = null;
  let projectConfig: LspConfigFile | null = null;
  const errors: string[] = [];

  const globalExists = await fileExists(globalPath);
  if (globalExists) {
    try {
      const content = await readFile(globalPath, "utf-8");
      globalConfig = JSON.parse(content) as LspConfigFile;
    } catch (e) {
      errors.push(`Failed to read global config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const projectExists = await fileExists(projectPath);
  if (projectExists) {
    try {
      const content = await readFile(projectPath, "utf-8");
      projectConfig = JSON.parse(content) as LspConfigFile;
    } catch (e) {
      errors.push(`Failed to read project config: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Check for disabled
  if (globalConfig?.lsp === false || projectConfig?.lsp === false) {
    return { servers: [], globalDisabled: true, errors };
  }

  // Merge configs
  const merged = mergeConfigs(globalConfig?.lsp, projectConfig?.lsp);

  // Resolve servers
  const servers: ResolvedServerConfig[] = [];
  for (const [name, userConfig] of Object.entries(merged)) {
    const resolved = resolveServerConfig(name, userConfig);
    if (resolved) {
      servers.push(resolved);
    }
  }

  return { servers, globalDisabled: false, errors };
}

const STARTER_CONFIG = {
  lsp: {
    typescript: {
      command: ["typescript-language-server", "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    },
  },
};

async function scaffoldStarterConfig(): Promise<string> {
  const globalDir = join(homedir(), GLOBAL_CONFIG_DIR_SUFFIX);
  const globalPath = join(globalDir, GLOBAL_CONFIG_FILENAME);

  await mkdir(globalDir, { recursive: true });
  await writeFile(globalPath, JSON.stringify(STARTER_CONFIG, null, 2), "utf-8");

  return globalPath;
}

// --- Default Export ---

export default async function lspExtension(pi: ExtensionAPI) {
  let rootPath = "";
  let config: LoadedConfig | null = null;
  const clients = new Map<string, LspClient>();

  // --- Helper functions ---

  function refreshStatus(ui: {
    setStatus: (key: string, text: string | undefined) => void;
    theme: any;
  }): void {
    const line = (text: string) =>
      `${ui.theme.fg(ICON_COLOR, STATUS_ICON)} ${ui.theme.fg(TEXT_COLOR, text)}`;
    if (!config) {
      ui.setStatus(STATUS_KEY, line("LSP: no servers detected"));
      return;
    }
    if (config.globalDisabled) {
      ui.setStatus(STATUS_KEY, line("LSP: disabled"));
      return;
    }
    if (config.servers.length === 0) {
      ui.setStatus(STATUS_KEY, line("LSP: no servers detected"));
      return;
    }

    const runningNames: string[] = [];
    const allNames: string[] = [];
    for (const server of config.servers) {
      allNames.push(server.name);
      const client = clients.get(server.name);
      if (client?.isRunning()) {
        runningNames.push(server.name);
      }
    }

    if (runningNames.length > 0) {
      ui.setStatus(STATUS_KEY, line(`LSP: ${runningNames.join(", ")} (running)`));
    } else {
      ui.setStatus(STATUS_KEY, line(`LSP: ${allNames.join(", ")}`));
    }
  }

  async function shutdownAll(): Promise<void> {
    const shutdowns: Promise<void>[] = [];
    for (const [_name, client] of clients) {
      shutdowns.push(
        client.shutdown().catch(() => {
          // Best-effort
        }),
      );
    }
    await Promise.all(shutdowns);
    clients.clear();
  }

  function clientsForFile(filePath: string): LspClient[] {
    if (!config) return [];
    const ext = getExtension(filePath);
    const result: LspClient[] = [];
    for (const server of config.servers) {
      if (server.extensions.includes(ext)) {
        let client = clients.get(server.name);
        if (!client) {
          client = new LspClient(server, rootPath);
          clients.set(server.name, client);
        }
        result.push(client);
      }
    }
    return result;
  }

  async function clientForFileWithCapability(
    filePath: string,
    capability: string,
  ): Promise<LspClient> {
    const matching = clientsForFile(filePath);

    // First check already-initialized clients
    for (const client of matching) {
      if (client.isInitialized() && client.hasCapability(capability)) {
        return client;
      }
    }

    // Try the first not-yet-initialized client
    for (const client of matching) {
      if (!client.isInitialized()) {
        await client.ensureInitialized();
        if (client.hasCapability(capability)) {
          return client;
        }
      }
    }

    throw new Error(
      `No LSP server with '${capability}' capability found for ${filePath}. Check /lsp status.`,
    );
  }

  async function anyClient(): Promise<LspClient> {
    if (!config || config.servers.length === 0) {
      throw new Error("No LSP server available for workspace symbol search.");
    }

    // Try existing clients first
    for (const [, client] of clients) {
      if (client.isInitialized()) {
        return client;
      }
    }

    // Create and initialize the first server
    const server = config.servers[0];
    if (!server) {
      throw new Error("No LSP server available for workspace symbol search.");
    }

    let client = clients.get(server.name);
    if (!client) {
      client = new LspClient(server, rootPath);
      clients.set(server.name, client);
    }
    await client.ensureInitialized();
    return client;
  }

  // --- Retry logic ---

  async function withRetry<T>(
    client: LspClient,
    operation: LspOperation,
    fn: () => Promise<T>,
    isEmpty: (result: T) => boolean,
  ): Promise<T> {
    if (!RETRYABLE_OPS.has(operation) || !client.isRecentlyInitialized()) {
      return fn();
    }

    let result = await fn();
    if (!isEmpty(result)) return result;

    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      await sleep(RETRY_DELAY);
      result = await fn();
      if (!isEmpty(result)) return result;
    }

    return result;
  }

  // --- Event handlers ---

  pi.on("session_start", async (_event, ctx) => {
    rootPath = ctx.cwd;

    // Check if starter config needs scaffolding
    const globalPath = join(homedir(), GLOBAL_CONFIG_DIR_SUFFIX, GLOBAL_CONFIG_FILENAME);
    const projectPath = join(rootPath, PROJECT_CONFIG_PATH);
    const globalExists = await fileExists(globalPath);
    const projectExists = await fileExists(projectPath);

    let scaffolded = false;
    if (!globalExists && !projectExists) {
      try {
        await scaffoldStarterConfig();
        scaffolded = true;
      } catch {
        // Best-effort scaffolding
      }
    }

    // Reload config
    config = await loadConfig(rootPath);
    refreshStatus(ctx.ui);

    if (scaffolded) {
      ctx.ui.notify(
        "LSP: created starter config at ~/.pi/agent/extensions/lsp/config.json — edit it to add your servers.",
        "info",
      );
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await shutdownAll();
    config = null;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName === "lsp") {
      refreshStatus(ctx.ui);
    }
  });

  // --- Tool ---

  const TOOL_DESCRIPTION = `Interact with Language Server Protocol servers for code intelligence.

Supported operations:
  goToDefinition    — find where a symbol is defined
  findReferences    — find all references to a symbol
  hover             — get type info and documentation for a symbol
  diagnostics       — get type errors and lint warnings for a file
  documentSymbol    — get all symbols in a file (with line:column positions)
  workspaceSymbol   — search for symbols across the workspace
  goToImplementation — find implementations of an interface/abstract method
  prepareCallHierarchy — get call hierarchy item at a position
  incomingCalls     — find callers of a function/method (auto-prepares hierarchy)
  outgoingCalls     — find callees of a function/method (auto-prepares hierarchy)
  codeActions       — get quick fixes and refactoring suggestions

Parameters:
  operation (required) — one of the operations above
  filePath  — file path relative to project root (required for most operations)
  line      — line number, 1-indexed (required for position-based operations)
  character — column number, 1-indexed (required for position-based operations)
  query     — search string (required for workspaceSymbol)

Tips:
  — Position the character in the middle of the symbol name for best results.
  — Use hover before goToDefinition to quickly check signatures and docs.
  — workspaceSymbol may need a retry if the server is still indexing.`;

  const PROMPT_GUIDELINES = [
    "lsp line and character params are 1-indexed — use the values from the read tool or rg output directly.",
    "lsp `hover` is the fastest way to get a function signature, type params, and doc comment — prefer it over `goToDefinition` for quick type inspection.",
    "lsp `documentSymbol` returns line:column positions for each symbol — use those values directly for follow-up lsp operations.",
    "For lsp position-based operations, place the character in the **middle** of the symbol name, not at the first character.",
    "lsp `incomingCalls` and `outgoingCalls` automatically prepare the call hierarchy — no need to call `prepareCallHierarchy` first.",
    "lsp `workspaceSymbol` may return empty results while the LSP server is still indexing. If it returns nothing, wait a few seconds and retry.",
    "lsp `diagnostics` relies on server-pushed notifications which may be slow for some servers. For compiled languages (Rust, Go, C++), prefer running the compiler directly (e.g. `cargo check`, `go build`) for reliable error checking.",
    "Use lsp for type info, macro-generated symbols, and cross-module navigation. Use rg for simple text search and file discovery — it is faster and needs no server.",
    "lsp servers are auto-detected by file extension. Use /lsp to check status.",
  ];

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Object({
      operation: StringEnum(LSP_OPERATIONS),
      filePath: Type.Optional(
        Type.String({
          description: "File path relative to project root",
        }),
      ),
      line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
      character: Type.Optional(Type.Number({ description: "Column number (1-indexed)" })),
      query: Type.Optional(
        Type.String({
          description: "Search query (for workspaceSymbol)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const operation = params.operation as LspOperation;

      // Validate operation
      if (!(LSP_OPERATIONS as readonly string[]).includes(operation)) {
        throw new Error(`Unknown operation: ${operation}`);
      }

      // Parameter validation
      if (POSITION_OPS.has(operation)) {
        if (!params.filePath) {
          throw new Error(`Operation '${operation}' requires filePath`);
        }
        if (params.line === undefined || params.line === null) {
          throw new Error(`Operation '${operation}' requires line`);
        }
        if (params.character === undefined || params.character === null) {
          throw new Error(`Operation '${operation}' requires character`);
        }
      }

      if (FILE_OPS.has(operation)) {
        if (!params.filePath) {
          throw new Error(`Operation '${operation}' requires filePath`);
        }
      }

      if (QUERY_OPS.has(operation)) {
        if (!params.query) {
          throw new Error(`Operation '${operation}' requires query`);
        }
      }

      const filePath = params.filePath as string | undefined;
      const line = params.line as number | undefined;
      const character = params.character as number | undefined;
      const query = params.query as string | undefined;

      // Execute operation
      switch (operation) {
        case "diagnostics": {
          return await executeDiagnostics(filePath as string);
        }
        case "hover": {
          return await executeHover(filePath as string, line as number, character as number);
        }
        case "goToDefinition": {
          return await executeLocationOp(
            filePath as string,
            line as number,
            character as number,
            "definition",
            "Definition",
          );
        }
        case "findReferences": {
          return await executeLocationOp(
            filePath as string,
            line as number,
            character as number,
            "references",
            "References",
          );
        }
        case "goToImplementation": {
          return await executeLocationOp(
            filePath as string,
            line as number,
            character as number,
            "implementation",
            "Implementation",
          );
        }
        case "documentSymbol": {
          return await executeDocumentSymbol(filePath as string);
        }
        case "workspaceSymbol": {
          return await executeWorkspaceSymbol(query as string);
        }
        case "prepareCallHierarchy": {
          return await executePrepareCallHierarchy(
            filePath as string,
            line as number,
            character as number,
          );
        }
        case "incomingCalls": {
          return await executeIncomingCalls(
            filePath as string,
            line as number,
            character as number,
          );
        }
        case "outgoingCalls": {
          return await executeOutgoingCalls(
            filePath as string,
            line as number,
            character as number,
          );
        }
        case "codeActions": {
          return await executeCodeActions(filePath as string, line as number);
        }
        default: {
          throw new Error(`Unknown operation: ${operation}`);
        }
      }
    },
  });

  // --- Tool operation implementations ---

  async function executeDiagnostics(filePath: string) {
    const capability = "textDocumentSync";
    const matching = clientsForFile(filePath);

    // Check capabilities after initialization
    const capableClients: LspClient[] = [];
    for (const client of matching) {
      try {
        await client.ensureInitialized();
        if (client.hasCapability(capability)) {
          capableClients.push(client);
        }
      } catch {
        // Skip client that failed to initialize
      }
    }

    if (capableClients.length === 0) {
      throw new Error(
        `No LSP server with '${capability}' capability found for ${filePath}. Check /lsp status.`,
      );
    }

    const allGroups: Array<{
      source: string;
      diagnostics: Diagnostic[];
    }> = [];
    const errors: string[] = [];

    for (const client of capableClients) {
      try {
        const uri = await client.resyncDocument(filePath);
        await client.waitForDiagnostics(uri);
        const diags = client.getDiagnostics(uri);

        // Group by source
        const sourceMap = new Map<string, Diagnostic[]>();
        for (const diag of diags) {
          const source = diag.source ?? client.getServerName();
          let group = sourceMap.get(source);
          if (!group) {
            group = [];
            sourceMap.set(source, group);
          }
          group.push(diag);
        }

        for (const [source, diagnostics] of sourceMap) {
          allGroups.push({ source, diagnostics });
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    const text = formatDiagnostics(filePath, allGroups);
    const groups = allGroups.map((g) => ({
      source: g.source,
      count: g.diagnostics.length,
    }));

    let content = text;
    if (errors.length > 0) {
      content += `\n\nNote: ${errors.join("; ")}`;
    }

    return {
      content: [{ type: "text" as const, text: content }],
      details: { groups, errors },
    };
  }

  async function executeHover(filePath: string, line: number, character: number) {
    const capability = operationCapability("hover");
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const position = {
      line: toZeroIndexed(line),
      character: toZeroIndexed(character),
    };

    const hoverResult = await withRetry(
      client,
      "hover",
      () => client.hover(client.getUriForFile(filePath), position),
      (r) => r === null,
    );

    return {
      content: [
        { type: "text" as const, text: formatHover(hoverResult, filePath, line, character) },
      ],
      details: {},
    };
  }

  async function executeLocationOp(
    filePath: string,
    line: number,
    character: number,
    method: "definition" | "references" | "implementation",
    kind: string,
  ) {
    const op =
      method === "definition"
        ? ("goToDefinition" as LspOperation)
        : method === "references"
          ? ("findReferences" as LspOperation)
          : ("goToImplementation" as LspOperation);
    const capability = operationCapability(op);
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const position = {
      line: toZeroIndexed(line),
      character: toZeroIndexed(character),
    };
    const uri = client.getUriForFile(filePath);

    let result: unknown;
    if (method === "definition") {
      result = await withRetry(
        client,
        op,
        () => client.definition(uri, position),
        (r) => !r || (Array.isArray(r) && r.length === 0),
      );
    } else if (method === "references") {
      result = await withRetry(
        client,
        op,
        () => client.references(uri, position),
        (r) => !r || r.length === 0,
      );
    } else {
      result = await withRetry(
        client,
        op,
        () => client.implementation(uri, position),
        (r) => !r || (Array.isArray(r) && r.length === 0),
      );
    }

    const locations = normalizeLocations(result);

    return {
      content: [
        {
          type: "text" as const,
          text: formatLocations(locations, kind, filePath, line, character, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executeDocumentSymbol(filePath: string) {
    const capability = operationCapability("documentSymbol");
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const uri = client.getUriForFile(filePath);

    const result = await withRetry(
      client,
      "documentSymbol",
      () => client.documentSymbol(uri),
      (r) => !r || r.length === 0,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: formatDocumentSymbols(result, filePath, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executeWorkspaceSymbol(query: string) {
    const client = await anyClient();

    const result = await withRetry(
      client,
      "workspaceSymbol",
      () => client.workspaceSymbol(query),
      (r) => !r || r.length === 0,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: formatWorkspaceSymbols(result, query, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executePrepareCallHierarchy(filePath: string, line: number, character: number) {
    const capability = operationCapability("prepareCallHierarchy");
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const position = {
      line: toZeroIndexed(line),
      character: toZeroIndexed(character),
    };
    const uri = client.getUriForFile(filePath);

    const result = await client.prepareCallHierarchy(uri, position);

    return {
      content: [
        {
          type: "text" as const,
          text: formatCallHierarchy(result ?? [], filePath, line, character, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executeIncomingCalls(filePath: string, line: number, character: number) {
    const capability = operationCapability("incomingCalls");
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const position = {
      line: toZeroIndexed(line),
      character: toZeroIndexed(character),
    };
    const uri = client.getUriForFile(filePath);

    // Auto-prepare call hierarchy
    const hierarchyItems = await client.prepareCallHierarchy(uri, position);
    if (!hierarchyItems || hierarchyItems.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No call hierarchy item at ${filePath}:${line}:${character}`,
          },
        ],
        details: {},
      };
    }

    const target = hierarchyItems[0] as CallHierarchyItem;
    const calls = (await client.incomingCalls(target)) ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: formatIncomingCalls(calls, target, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executeOutgoingCalls(filePath: string, line: number, character: number) {
    const capability = operationCapability("outgoingCalls");
    const client = await clientForFileWithCapability(filePath, capability);
    await client.openDocument(filePath);

    const position = {
      line: toZeroIndexed(line),
      character: toZeroIndexed(character),
    };
    const uri = client.getUriForFile(filePath);

    // Auto-prepare call hierarchy
    const hierarchyItems = await client.prepareCallHierarchy(uri, position);
    if (!hierarchyItems || hierarchyItems.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No call hierarchy item at ${filePath}:${line}:${character}`,
          },
        ],
        details: {},
      };
    }

    const source = hierarchyItems[0] as CallHierarchyItem;
    const calls = (await client.outgoingCalls(source)) ?? [];

    return {
      content: [
        {
          type: "text" as const,
          text: formatOutgoingCalls(calls, source, rootPath),
        },
      ],
      details: {},
    };
  }

  async function executeCodeActions(filePath: string, line: number) {
    const capability = operationCapability("codeActions");
    const client = await clientForFileWithCapability(filePath, capability);

    const zeroLine = toZeroIndexed(line);

    // Resync to get fresh diagnostics
    const uri = await client.resyncDocument(filePath);
    await client.waitForDiagnostics(uri);

    // Filter diagnostics to those overlapping the requested line
    const allDiags = client.getDiagnostics(uri);
    const overlapping = allDiags.filter(
      (d) => d.range.start.line <= zeroLine && d.range.end.line >= zeroLine,
    );

    const range: Range = {
      start: { line: zeroLine, character: 0 },
      end: { line: zeroLine, character: CODEACTIONS_END_CHAR },
    };

    const actions = await client.codeActions(uri, range, overlapping);

    // Filter to CodeAction objects (not Command objects)
    const codeActions = actions.filter(
      (a) => a.kind !== undefined || a.edit !== undefined || a.isPreferred !== undefined,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: formatCodeActions(codeActions, filePath, zeroLine),
        },
      ],
      details: {},
    };
  }

  // --- Commands ---

  pi.registerCommand("lsp", {
    description: "Show LSP server status, detected servers, and their extensions",
    handler: async (_args, ctx) => {
      // Reload config
      config = await loadConfig(rootPath);
      refreshStatus(ctx.ui);

      // Build notification
      const lines: string[] = [];

      if (config.globalDisabled) {
        lines.push("  All servers disabled via config.");
      } else if (config.servers.length === 0) {
        lines.push("  No servers configured.");
        lines.push("  Add servers to ~/.pi/agent/extensions/lsp/config.json or .pi/lsp.json");
      } else {
        for (const server of config.servers) {
          const client = clients.get(server.name);
          const status = client?.isRunning() ? "running" : "available";
          const exts = server.extensions.join(", ");
          lines.push(`  ${server.name}: ${status} — handles ${exts}`);
        }
      }

      if (config.errors.length > 0) {
        lines.push("");
        lines.push("Config errors:");
        for (const error of config.errors) {
          lines.push(`  - ${error}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lsp-restart", {
    description: "Stop all LSP servers (they reinitialize on next tool use)",
    handler: async (_args, ctx) => {
      // Shutdown all
      await shutdownAll();

      // Clear and reload
      config = await loadConfig(rootPath);
      refreshStatus(ctx.ui);

      ctx.ui.notify("LSP servers stopped. Will reinitialize on next tool use.", "info");
    },
  });
}
