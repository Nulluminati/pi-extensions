import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { LspConnection } from "./connection.ts";
import { cleanPath, languageIdForPath, normalizeUri, pathToUri } from "./paths.ts";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  Diagnostic,
  Hover,
  Location,
  Position,
  Range,
  ResolvedServerConfig,
  SymbolInformation,
} from "./types.ts";

// --- LspClient ---

const DIAGNOSTIC_WAIT_TIMEOUT = 10_000;

const RECENTLY_INITIALIZED_WINDOW = 30_000;

interface PendingDiagnostic {
  resolve: (diags: Diagnostic[]) => void;
  timer: NodeJS.Timeout;
}

interface OpenDocument {
  version: number;
  text: string;
}

export class LspClient {
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
