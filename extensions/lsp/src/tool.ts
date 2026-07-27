import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const LSP_OPERATIONS = [
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

export type LspOperation = (typeof LSP_OPERATIONS)[number];

export interface LspToolParams {
  operation: string;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
}

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

// Operation capability mapping

export function operationCapability(op: LspOperation): string {
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

export function isRetryableOperation(operation: LspOperation): boolean {
  return RETRYABLE_OPS.has(operation);
}

export function validateLspParams(params: LspToolParams): LspOperation {
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

  return operation;
}

// --- Tool ---

export const TOOL_DESCRIPTION = `Interact with Language Server Protocol servers for code intelligence.

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

export const PROMPT_GUIDELINES = [
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

export const LSP_TOOL_PARAMETERS = Type.Object({
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
});
