import { relativePath } from "./paths.ts";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Range,
  SymbolInformation,
} from "./types.ts";

// Formatting helpers

const WORKSPACE_SYMBOLS_LIMIT = 50;

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

export function formatDiagnostics(
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

export function formatHover(
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

export function formatLocations(
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

export function formatDocumentSymbols(
  result: unknown[],
  filePath: string,
  rootPath: string,
): string {
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

export function formatWorkspaceSymbols(
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

export function formatCallHierarchy(
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

export function formatIncomingCalls(
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

export function formatOutgoingCalls(
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

export function formatCodeActions(actions: CodeAction[], filePath: string, line: number): string {
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

export function normalizeLocations(result: unknown): Location[] {
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
