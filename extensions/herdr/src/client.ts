/** Bounded JSON-line requests to Herdr's local socket. */

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { MetadataTokens } from "./metadata.ts";

export interface MetadataReport {
  pane_id: string;
  source: string;
  seq: number;
  ttl_ms: number;
  tokens: MetadataTokens;
}

export async function reportMetadata(
  socketPath: string,
  report: MetadataReport,
  signal?: AbortSignal,
): Promise<void> {
  await requestHerdr(socketPath, "pane.report_metadata", report, {
    ...(signal !== undefined ? { signal } : {}),
    id: `${report.source}:${report.seq}`,
    timeoutMs: 1_000,
  });
}

export class HerdrRequestError extends Error {
  readonly code: unknown;

  constructor(message: string, code?: unknown) {
    super(message);
    this.code = code;
  }
}

export function requestHerdr(
  socketPath: string,
  method: string,
  params: object,
  options: { signal?: AbortSignal; id?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const { signal, id = randomUUID(), timeoutMs = 5_000 } = options;
  const label = method === "pane.report_metadata" ? "metadata" : "pane";
  if (signal?.aborted) return Promise.reject(new Error(`Herdr ${label} request cancelled`));
  const endpoint =
    process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\")
      ? `\\\\.\\pipe\\${socketPath}`
      : socketPath;

  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error(`Herdr ${label} request timed out`)),
      timeoutMs,
    );
    timeout.unref?.();

    function finish(error?: Error, result: Record<string, unknown> = {}): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    function abort(): void {
      finish(new Error(`Herdr ${label} request cancelled`));
    }

    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", finish);
    socket.on("end", () => finish(new Error(`Herdr socket ended before a ${label} response`)));
    socket.on("close", () => finish(new Error(`Herdr socket closed before a ${label} response`)));
    socket.on("connect", () => {
      if (settled) return;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65_536) {
        finish(new Error(`Herdr ${label} response exceeded 64 KiB`));
        return;
      }
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response: unknown = JSON.parse(line);
          if (typeof response !== "object" || response === null || Array.isArray(response))
            throw new Error(`Herdr returned an invalid ${label} response`);
          const frame = response as Record<string, unknown>;
          if (frame.id === id) {
            if (frame.error !== undefined) {
              const error = frame.error;
              const message =
                typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof error.message === "string"
                  ? error.message
                  : label === "metadata"
                    ? "Herdr rejected the metadata report"
                    : "Herdr rejected the pane request";
              const code =
                typeof error === "object" && error !== null && "code" in error
                  ? error.code
                  : undefined;
              finish(new HerdrRequestError(message, code));
            } else if (typeof frame.result === "object" && frame.result !== null) {
              finish(undefined, frame.result as Record<string, unknown>);
            } else {
              throw new Error(`Herdr returned an invalid ${label} response`);
            }
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
}
