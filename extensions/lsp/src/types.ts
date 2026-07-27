// --- Types ---

export interface ResolvedServerConfig {
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  env: Record<string, string>;
  initializationOptions: Record<string, unknown>;
}

export interface LoadedConfig {
  servers: ResolvedServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

export interface LspServerUserConfig {
  command?: string[];
  extensions?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

export interface LspConfigFile {
  lsp?: false | Record<string, LspServerUserConfig>;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface Diagnostic {
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

export interface Hover {
  contents: unknown;
  range?: Range;
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  detail?: string;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface WorkspaceEdit {
  changes?: Record<string, Array<{ range: Range; newText: string }>>;
  documentChanges?: unknown[];
}
