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
import { SANDBOX_EXEC_EVENT, type SandboxExecRequest } from "../../lib/sandbox-exec.ts";
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
  let stopExecListening: (() => void) | undefined;

  async function activeClient(): Promise<WorkerSandboxClient> {
    if (startError) throw startError;
    if (client) return client;
    if (starting) return starting;
    throw new Error("Worker sandbox not ready; refusing host execution");
  }

  /** Run another extension's shell command in the sandbox. Output is capped
   * at the request's byte limit; failures never fall back to the host. */
  function receiveExecRequest(data: unknown): void {
    if (!sandboxActive) return;
    const request = data as SandboxExecRequest;
    request.claim();
    let output = "";
    let truncated = false;
    const onData = (chunk: Buffer) => {
      const room = request.maxOutputBytes - Buffer.byteLength(output);
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      if (Buffer.byteLength(text) > room) truncated = true;
      output += Buffer.from(text).subarray(0, room).toString("utf8");
    };
    const captured = () => (truncated ? `${output}…[truncated]` : output);
    void activeClient()
      .then((sandbox) =>
        sandbox.runShell(request.command, {
          cwd: request.cwd,
          onData,
          timeout: Math.ceil(request.timeoutMs / 1000),
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      )
      .then(({ exitCode }) => {
        if (exitCode === 0) {
          request.respond({ ok: true, output: "" });
          return;
        }
        request.respond({ ok: false, output: `${captured()}\nexit code ${exitCode}`.trim() });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        request.respond({
          ok: false,
          output: `${captured()}\nSandboxed command failed: ${message}`.trim(),
        });
      });
  }

  pi.on("session_start", async (_event, ctx) => {
    // Pi parses extension flag values after the factory has registered them.
    const sessionPolicy = pi.getFlag("sandbox");
    sandboxActive = worker || sessionPolicy !== undefined;
    if (!sandboxActive) return;
    registerSandboxTools();
    if (!stopExecListening)
      stopExecListening = pi.events.on(SANDBOX_EXEC_EVENT, receiveExecRequest);
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
    stopExecListening?.();
    stopExecListening = undefined;
    try {
      await starting;
    } catch {
      // Startup failures release broker resources in startWorkerSandbox.
    }
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
    // The documentation and code search tools only read remote results.
    const allowed = new Set([
      ...tools.map((tool) => tool.name),
      "web_fetch",
      "web_search",
      "context7_resolve_library_id",
      "context7_get_library_docs",
      "context7_get_cached_doc_raw",
      "code_search",
    ]);
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
