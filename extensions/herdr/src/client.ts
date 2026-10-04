/** Bounded JSON-line requests to Herdr's local socket. */

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

export function reportMetadata(
  socketPath: string,
  report: MetadataReport,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Herdr metadata request cancelled"));
  const endpoint =
    process.platform === "win32" && !socketPath.startsWith("\\\\.\\pipe\\")
      ? `\\\\.\\pipe\\${socketPath}`
      : socketPath;
  const id = `${report.source}:${report.seq}`;

  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Herdr metadata request timed out")), 1_000);
    timeout.unref?.();

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }

    function abort(): void {
      finish(new Error("Herdr metadata request cancelled"));
    }

    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", finish);
    socket.on("end", () => finish(new Error("Herdr socket ended before a metadata response")));
    socket.on("close", () => finish(new Error("Herdr socket closed before a metadata response")));
    socket.on("connect", () => {
      if (settled) return;
      socket.write(`${JSON.stringify({ id, method: "pane.report_metadata", params: report })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65_536) {
        finish(new Error("Herdr metadata response exceeded 64 KiB"));
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
            throw new Error("Herdr returned an invalid metadata response");
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
                  : "Herdr rejected the metadata report";
              finish(new Error(message));
            } else if (typeof frame.result === "object" && frame.result !== null) {
              finish();
            } else {
              throw new Error("Herdr returned an invalid metadata response");
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
