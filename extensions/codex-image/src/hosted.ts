// Hosted image generation for ChatGPT's Codex backend.
//
// The Codex `responses` endpoint answers `stream: true` requests with SSE
// events. Image generation runs as a tool call: partial previews arrive as
// `response.image_generation_call.partial_image` events and the finished PNG
// lands in the `result` of the completed image generation item. This module
// posts one request, forwards previews to `onPartial`, and resolves only with
// the final PNG.

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const IMAGE_INSTRUCTIONS = "Use the image generation tool to create the requested image.";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
// Error bodies are server-controlled text: cap them and strip data URLs so no
// image bytes (and never credentials) end up in an error message.
const ERROR_BODY_LIMIT = 400;
const DATA_URL_PATTERN = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

// --- Types ---

export interface HostedImageRequest {
  prompt: string;
  inputImages?: string[];
  responseModel: string;
  imageModel?: string;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high";
}

interface ImageGenerationItem {
  type?: string;
  result?: string;
}

interface StreamEventBody {
  type?: string;
  message?: string;
  code?: string;
  partial_image_b64?: string;
  item?: ImageGenerationItem;
  response?: {
    error?: { message?: string; code?: string };
    output?: ImageGenerationItem[];
  };
}

interface StreamOutcome {
  finalImage?: string;
  sawPartial: boolean;
}

// --- Request building ---

function buildRequestBody(request: HostedImageRequest): Record<string, unknown> {
  const content: Array<{ type: string; text?: string; image_url?: string }> = [
    { type: "input_text", text: request.prompt },
  ];
  for (const dataUrl of request.inputImages ?? []) {
    content.push({ type: "input_image", image_url: dataUrl });
  }
  return {
    model: request.responseModel,
    instructions: IMAGE_INSTRUCTIONS,
    input: [{ role: "user", content }],
    tools: [
      {
        type: "image_generation",
        action: "auto",
        model: request.imageModel ?? DEFAULT_IMAGE_MODEL,
        background: "auto",
        quality: request.quality ?? "auto",
        size: request.size ?? "auto",
        output_format: "png",
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
}

// --- Error body capping ---

function describeErrorBody(bodyText: string): string {
  const redacted = bodyText.replace(DATA_URL_PATTERN, "[data url]");
  const flattened = redacted.replace(/\s+/g, " ").trim();
  if (flattened.length === 0) return "";
  return flattened.length > ERROR_BODY_LIMIT
    ? `${flattened.slice(0, ERROR_BODY_LIMIT)}...`
    : flattened;
}

// --- SSE parsing ---

/**
 * Finds the next blank-line event terminator. `\n\n` and `\r\n\r\n` cannot
 * contain each other, so the earliest match wins.
 */
function nextEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf === -1 || (lf !== -1 && lf < crlf)) {
    if (lf === -1) return undefined;
    return { index: lf, length: 2 };
  }
  return { index: crlf, length: 4 };
}

function extractDataPayload(rawEvent: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}

function streamEvent(rawEvent: string): StreamEventBody | undefined {
  const payload = extractDataPayload(rawEvent);
  if (!payload || payload === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as StreamEventBody;
  } catch {
    return undefined; // keepalives and non-JSON noise are ignored
  }
}

// --- Stream handling ---

function itemResult(item: ImageGenerationItem | undefined): string | undefined {
  return typeof item?.result === "string" && item.result.length > 0 ? item.result : undefined;
}

function applyStreamEvent(
  rawEvent: string,
  outcome: StreamOutcome,
  onPartial?: (base64: string) => void,
): void {
  const event = streamEvent(rawEvent);
  if (!event) return;

  if (event.type === "response.failed") {
    const message =
      event.response?.error?.message ?? event.response?.error?.code ?? "unknown error";
    throw new Error(`ChatGPT image generation failed: ${describeErrorBody(message)}`);
  }
  if (event.type === "error") {
    const message = event.message ?? event.code ?? "unknown error";
    throw new Error(`ChatGPT image generation failed: ${describeErrorBody(message)}`);
  }
  if (event.type === "response.image_generation_call.partial_image") {
    const partial = event.partial_image_b64;
    if (typeof partial === "string" && partial.length > 0) {
      outcome.sawPartial = true;
      onPartial?.(partial);
    }
    return;
  }
  if (
    event.type === "response.image_generation_call.completed" ||
    (event.type === "response.output_item.done" && event.item?.type === "image_generation_call")
  ) {
    const result = itemResult(event.item);
    if (result) outcome.finalImage = result;
    return;
  }
  if (event.type === "response.completed") {
    const output = event.response?.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        const result = itemResult(item);
        if (result) outcome.finalImage = result;
      }
    }
  }
}

/**
 * Reads the body incrementally and emits one raw SSE event per blank-line
 * terminator. A trailing event without a terminator is still emitted.
 */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onRawEvent: (rawEvent: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Cancel the underlying stream on abort so the connection is released even
  // if the runtime does not reject the pending read.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = nextEventBoundary(buffer);
      while (boundary) {
        onRawEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = nextEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) onRawEvent(buffer);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
}

/** Emits every complete SSE event in an already-read body (no-stream fallback). */
function emitEventsFromText(text: string, onRawEvent: (rawEvent: string) => void): void {
  let buffer = text;
  let boundary = nextEventBoundary(buffer);
  while (boundary) {
    onRawEvent(buffer.slice(0, boundary.index));
    buffer = buffer.slice(boundary.index + boundary.length);
    boundary = nextEventBoundary(buffer);
  }
  if (buffer.trim().length > 0) onRawEvent(buffer);
}

/**
 * Rejects as soon as the signal aborts, even if the read loop itself stays
 * pending. `signal.reason` is a DOMException named AbortError in Node.
 */
function abortGuard(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const onAbort = () => rejectPromise?.(signal.reason);
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

async function consumeImageStream(
  response: Response,
  signal: AbortSignal,
  onPartial?: (base64: string) => void,
): Promise<string> {
  const outcome: StreamOutcome = { sawPartial: false };
  const onRawEvent = (rawEvent: string) => applyStreamEvent(rawEvent, outcome, onPartial);

  const guard = abortGuard(signal);
  let streamDone: Promise<void> = Promise.resolve();
  try {
    if (response.body) {
      streamDone = readEventStream(response.body, signal, onRawEvent);
    } else {
      const text = await response.text();
      emitEventsFromText(text, onRawEvent);
    }
    await Promise.race([streamDone, guard.promise]);
  } finally {
    guard.dispose();
    // Aborting wins the race while the read loop is still pending; silence the
    // late rejection so it never surfaces as an unhandled error.
    streamDone.catch(() => {});
  }

  if (outcome.finalImage) return outcome.finalImage;
  if (outcome.sawPartial) {
    throw new Error(
      "ChatGPT image generation ended without a final image; only partial previews were received.",
    );
  }
  throw new Error("ChatGPT image generation did not return a final image.");
}

// --- Entry point ---

export async function generateHostedImage(
  request: HostedImageRequest,
  credentials: { accessToken: string; accountId: string },
  signal: AbortSignal,
  onPartial?: (base64: string) => void,
): Promise<string> {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal,
  });

  if (!response.ok) {
    const detail = describeErrorBody(await response.text());
    const suffix = detail.length > 0 ? `: ${detail}` : "";
    throw new Error(`ChatGPT image generation request failed (HTTP ${response.status})${suffix}`);
  }

  return consumeImageStream(response, signal, onPartial);
}
