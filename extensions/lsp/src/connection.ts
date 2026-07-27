import { spawn } from "node:child_process";

// --- LspConnection (JSON-RPC over stdio) ---

const REQUEST_TIMEOUT = 30_000;

const SHUTDOWN_TIMEOUT = 5_000;

const STDERR_LOG_BUFFER_SIZE = 100;

export class LspConnection {
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
