/** A dedicated, bounded worker-parent approval pipe. Task output never uses this channel. */

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

export const WORKER_APPROVAL_FD_ENV_VAR = "PI_WORKER_APPROVAL_FD";
export const WORKER_APPROVAL_EVENT = "approval-mode:worker-request";
const MAX_FRAME_BYTES = 32 * 1024;
const MAX_PENDING = 16;
const MODE_TIMEOUT_MS = 5_000;
const APPROVAL_TIMEOUT_MS = 300_000;

export interface WorkerIdentity {
  id: string;
  name: string;
  cwd: string;
}

export type WorkerApprovalRequest =
  | { kind: "mode" }
  | {
      kind: "approval";
      command: string;
      cwd: string;
      toolName: string;
      decision: "reject" | "uncertain";
      reason: string;
    };

export type WorkerApprovalReply = { enabled: boolean } | { approved: boolean } | { error: string };
export type WorkerApprovalHandler = (
  request: WorkerApprovalRequest,
  signal: AbortSignal,
) => Promise<WorkerApprovalReply>;

export interface WorkerApprovalEvent {
  worker: WorkerIdentity;
  request: WorkerApprovalRequest;
  signal: AbortSignal;
  respond(reply: WorkerApprovalReply): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validRequest(value: unknown): value is WorkerApprovalRequest {
  if (!object(value)) return false;
  if (value.kind === "mode") return Object.keys(value).length === 1;
  return (
    value.kind === "approval" &&
    Object.keys(value).length === 6 &&
    text(value.command, 16_000) &&
    text(value.cwd, 4_096) &&
    text(value.reason, 4_096) &&
    ["bash", "background", "monitor"].includes(String(value.toolName)) &&
    (value.decision === "reject" || value.decision === "uncertain")
  );
}

function validReply(reply: unknown, request: WorkerApprovalRequest): reply is WorkerApprovalReply {
  if (!object(reply) || Object.keys(reply).length !== 1) return false;
  if (text(reply.error, 4_096)) return true;
  return request.kind === "mode"
    ? typeof reply.enabled === "boolean"
    : typeof reply.approved === "boolean";
}

function timeout(request: WorkerApprovalRequest): number {
  return request.kind === "mode" ? MODE_TIMEOUT_MS : APPROVAL_TIMEOUT_MS;
}

/** UTF-8 decoding happens before framing, so byte boundaries cannot change command text. */
function peer(
  stream: Duplex,
  receive: (frame: Record<string, unknown>) => boolean,
  disconnected: () => void,
) {
  let closed = false;
  let buffer = "";
  const close = () => {
    if (closed) return;
    closed = true;
    disconnected();
    stream.destroy();
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        close();
        return;
      }
      try {
        const frame: unknown = JSON.parse(line);
        if (!object(frame) || !receive(frame)) {
          close();
          return;
        }
      } catch {
        close();
        return;
      }
      if (closed) return;
      end = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) close();
  });
  // Errors are expressed as denied pending calls, not uncaught stream errors.
  stream.on("error", close);
  stream.on("end", close);
  stream.on("close", close);
  (stream as Duplex & { unref?(): void }).unref?.();
  return {
    close,
    write(frame: unknown): boolean {
      if (closed) return false;
      try {
        const line = JSON.stringify(frame);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return false;
        stream.write(`${line}\n`);
        return true;
      } catch {
        close();
        return false;
      }
    },
  };
}

export function createWorkerApprovalClient(stream: Duplex) {
  let closed = false;
  const pending = new Map<
    string,
    {
      request: WorkerApprovalRequest;
      finish(reply: WorkerApprovalReply): void;
    }
  >();
  const transport = peer(
    stream,
    (frame) => {
      if (!text(frame.id, 128) || Object.keys(frame).length !== 2) return false;
      const call = pending.get(frame.id);
      // Late replies to cancelled calls carry no permission for another call.
      if (!call) return true;
      if (!validReply(frame.reply, call.request)) return false;
      call.finish(frame.reply);
      return true;
    },
    () => {
      closed = true;
      for (const call of pending.values())
        call.finish({ error: "Parent approval channel disconnected" });
    },
  );
  return {
    close: transport.close,
    request(request: WorkerApprovalRequest, signal?: AbortSignal): Promise<WorkerApprovalReply> {
      if (closed || signal?.aborted || !validRequest(request)) {
        return Promise.resolve({
          error: "Parent approval channel unavailable or request cancelled",
        });
      }
      if (pending.size >= MAX_PENDING)
        return Promise.resolve({ error: "Too many pending approvals" });
      const id = randomUUID();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (reply: WorkerApprovalReply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          pending.delete(id);
          if (pending.size === 0) (stream as Duplex & { unref?(): void }).unref?.();
          resolve(reply);
        };
        const cancel = () => {
          transport.write({ id, cancel: true });
          finish({ error: "Worker approval cancelled" });
        };
        const timer = setTimeout(() => {
          transport.write({ id, cancel: true });
          finish({ error: "Worker approval timed out" });
        }, timeout(request));
        pending.set(id, { request, finish });
        (stream as Duplex & { ref?(): void }).ref?.();
        signal?.addEventListener("abort", cancel, { once: true });
        if (!transport.write({ id, request }))
          finish({ error: "Worker approval could not be sent" });
      });
    },
  };
}

export function connectWorkerApprovalChannel(fd: number) {
  try {
    if (fd !== 3) throw new Error("Invalid approval descriptor");
    return createWorkerApprovalClient(new Socket({ fd, readable: true, writable: true }));
  } catch {
    return {
      close() {},
      request(
        _request: WorkerApprovalRequest,
        _signal?: AbortSignal,
      ): Promise<WorkerApprovalReply> {
        return Promise.resolve({ error: "Parent approval channel unavailable" });
      },
    };
  }
}

export function attachParentApprovalChannel(stream: Duplex, handler: WorkerApprovalHandler) {
  const pending = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  const complete = (id: string, reply?: WorkerApprovalReply) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    call.controller.abort();
    if (reply) transport.write({ id, reply });
  };
  const transport = peer(
    stream,
    (frame) => {
      if (!text(frame.id, 128) || Object.keys(frame).length !== 2) return false;
      const id = frame.id;
      if (frame.cancel === true) {
        complete(id);
        return true;
      }
      if (!validRequest(frame.request) || pending.has(id)) return false;
      if (pending.size >= MAX_PENDING) {
        transport.write({ id, reply: { error: "Too many pending approvals" } });
        return true;
      }
      const request = frame.request;
      const controller = new AbortController();
      const timer = setTimeout(
        () => complete(id, { error: "Worker approval timed out" }),
        timeout(request),
      );
      pending.set(id, { controller, timer });
      void Promise.resolve()
        .then(() => handler(request, controller.signal))
        .then((reply) => {
          complete(
            id,
            validReply(reply, request) ? reply : { error: "Invalid parent approval reply" },
          );
        })
        .catch(() => complete(id, { error: "Parent approval handler failed" }));
      return true;
    },
    () => {
      for (const id of pending.keys()) complete(id);
    },
  );
  return { close: transport.close };
}

/** The parent extension handles this event itself; no model or messenger grants permission. */
export function dispatchWorkerApproval(
  events: { emit(event: string, data: unknown): void },
  worker: WorkerIdentity,
  request: WorkerApprovalRequest,
  signal: AbortSignal,
): Promise<WorkerApprovalReply> {
  return new Promise((resolve) => {
    let settled = false;
    const respond = (reply: WorkerApprovalReply) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      resolve(validReply(reply, request) ? reply : { error: "Invalid parent approval reply" });
    };
    const cancel = () => respond({ error: "Worker approval cancelled" });
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    try {
      events.emit(WORKER_APPROVAL_EVENT, {
        worker,
        request,
        signal,
        respond,
      } satisfies WorkerApprovalEvent);
    } catch {
      respond({ error: "Parent approval handler failed" });
    }
  });
}
