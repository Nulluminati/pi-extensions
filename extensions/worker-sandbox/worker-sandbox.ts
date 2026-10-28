/**
 * Session sandbox: every built-in file and shell tool runs in a sandboxed child.
 * A missing policy or failed broker never falls back to host execution.
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { startWorkerSandbox, type WorkerSandboxClient } from "./src/client.ts";

// --- Extension ---
export default async function workerSandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("sandbox", {
    description: "Sandbox this session with an inline sandbox-runtime JSON policy",
    type: "string",
  });
  const worker = process.env.PI_WORKER === "1";
  let sandboxActive = worker;
  let toolsRegistered = false;

  const localCwd = process.cwd();
  let client: WorkerSandboxClient | undefined;
  let starting: Promise<WorkerSandboxClient> | undefined;
  let startError: Error | undefined;

  async function activeClient(): Promise<WorkerSandboxClient> {
    if (startError) throw startError;
    if (client) return client;
    if (starting) return starting;
    throw new Error("Worker sandbox not ready; refusing host execution");
  }

  pi.on("session_start", async (_event, ctx) => {
    // Pi parses extension flag values after the factory has registered them.
    const sessionPolicy = pi.getFlag("sandbox");
    sandboxActive = worker || sessionPolicy !== undefined;
    if (!sandboxActive) return;
    registerSandboxTools();
    if (starting || client) return;
    startError = undefined;
    starting = worker
      ? startWorkerSandbox(ctx.cwd)
      : typeof sessionPolicy === "string"
        ? startWorkerSandbox(ctx.cwd, sessionPolicy)
        : Promise.reject(new Error("--sandbox requires a JSON policy"));
    try {
      client = await starting;
    } catch (error) {
      startError = error instanceof Error ? error : new Error(String(error));
      throw startError;
    } finally {
      starting = undefined;
    }
  });

  pi.on("session_shutdown", async () => {
    const running = client;
    client = undefined;
    starting = undefined;
    if (running) await running.close();
  });

  // Register the full built-in tool definitions so metadata (promptSnippet,
  // promptGuidelines) and renderers survive; only execute is replaced to
  // route every call into the sandbox.
  const tools: ToolDefinition<any, any, any>[] = [
    createReadToolDefinition(localCwd),
    createWriteToolDefinition(localCwd),
    createEditToolDefinition(localCwd),
    createBashToolDefinition(localCwd),
    createLsToolDefinition(localCwd),
    createFindToolDefinition(localCwd),
    createGrepToolDefinition(localCwd),
  ];
  function registerSandboxTools() {
    if (toolsRegistered) return;
    toolsRegistered = true;
    for (const tool of tools) {
      pi.registerTool({
        ...tool,
        async execute(
          _id: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<any> | undefined,
          ctx: ExtensionContext,
        ) {
          return (await activeClient()).runTool(tool.name, params, {
            cwd: ctx.cwd,
            ...(signal ? { signal } : {}),
            ...(onUpdate ? { onUpdate } : {}),
          });
        },
      });
    }
  }
  if (worker) registerSandboxTools();

  if (!worker) {
    // Other extension tools can execute on the host. Deny them even when
    // invoked indirectly; only the explicit web-tool exceptions stay outside.
    const allowed = new Set([...tools.map((tool) => tool.name), "web_fetch", "web_search"]);
    pi.on("tool_call", (event) => {
      if (sandboxActive && !allowed.has(event.toolName)) {
        return {
          block: true,
          reason: `Session sandbox cannot safely run ${event.toolName}. Use sandboxed bash instead.`,
        };
      }
      return undefined;
    });
  }

  pi.on("user_bash", () => {
    if (!sandboxActive) return undefined;
    return {
      operations: {
        async exec(
          command: string,
          cwd: string,
          options: {
            onData: (chunk: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: NodeJS.ProcessEnv;
          },
        ) {
          return (await activeClient()).runShell(command, {
            cwd,
            onData: options.onData,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
            ...(options.env ? { env: options.env } : {}),
          });
        },
      },
    };
  });
}
