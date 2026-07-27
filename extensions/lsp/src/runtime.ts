import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "pi";
import { LspClient } from "./client.ts";
import {
  fileExists,
  GLOBAL_CONFIG_DIR_SUFFIX,
  GLOBAL_CONFIG_FILENAME,
  loadConfig,
  PROJECT_CONFIG_PATH,
  scaffoldStarterConfig,
} from "./config.ts";
import { ICON_COLOR, STATUS_ICON, TEXT_COLOR } from "./constants.ts";
import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
  normalizeLocations,
} from "./formatting.ts";
import { getExtension, toZeroIndexed } from "./paths.ts";
import {
  isRetryableOperation,
  type LspOperation,
  type LspToolParams,
  operationCapability,
  validateLspParams,
} from "./tool.ts";
import type { CallHierarchyItem, Diagnostic, LoadedConfig, Range } from "./types.ts";

// --- Constants ---

const RETRY_MAX_ATTEMPTS = 2;
const RETRY_DELAY = 2_000;
const STATUS_KEY = "lsp";
const CODEACTIONS_END_CHAR = Number.MAX_SAFE_INTEGER;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLspRuntime() {
  let rootPath = "";
  let config: LoadedConfig | null = null;
  const clients = new Map<string, LspClient>();

  // --- Helper functions ---

  function refreshStatus(ui: ExtensionContext["ui"]): void {
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
    if (!isRetryableOperation(operation) || !client.isRecentlyInitialized()) {
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

  async function sessionStart(ctx: ExtensionContext): Promise<void> {
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
  }

  async function sessionShutdown(): Promise<void> {
    await shutdownAll();
    config = null;
  }

  async function execute(params: LspToolParams) {
    const operation = validateLspParams(params);
    const filePath = params.filePath;
    const line = params.line;
    const character = params.character;
    const query = params.query;

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
        return await executeIncomingCalls(filePath as string, line as number, character as number);
      }
      case "outgoingCalls": {
        return await executeOutgoingCalls(filePath as string, line as number, character as number);
      }
      case "codeActions": {
        return await executeCodeActions(filePath as string, line as number);
      }
      default: {
        throw new Error(`Unknown operation: ${operation}`);
      }
    }
  }

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

  async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
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
  }

  async function restart(ctx: ExtensionCommandContext): Promise<void> {
    // Shutdown all
    await shutdownAll();

    // Clear and reload
    config = await loadConfig(rootPath);
    refreshStatus(ctx.ui);

    ctx.ui.notify("LSP servers stopped. Will reinitialize on next tool use.", "info");
  }

  return {
    execute,
    refreshStatus,
    restart,
    sessionShutdown,
    sessionStart,
    showStatus,
  };
}
