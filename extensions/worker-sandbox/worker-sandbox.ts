/**
 * Worker sandbox: every built-in file and shell tool runs in a sandboxed child.
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
  if (process.env.PI_WORKER !== "1") return;

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
    if (starting || client) return;
    startError = undefined;
    starting = startWorkerSandbox(ctx.cwd);
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

  pi.on("user_bash", () => ({
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
  }));
}
