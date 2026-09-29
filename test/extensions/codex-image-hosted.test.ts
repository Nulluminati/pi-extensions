import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateHostedImage,
  type HostedImageRequest,
} from "../../extensions/codex-image/src/hosted.ts";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = "test-access-token";
const ACCOUNT_ID = "acc-0001";
const FINAL_IMAGE_B64 = "ZmluYWwtcG5nLWJ5dGVz"; // "final-png-bytes"
const PARTIAL_IMAGE_B64 = "cGFydGlhbC1wbmctYnl0ZXM="; // "partial-png-bytes"
const DATA_URL = "data:image/png;base64,aW5wdXQtaW1hZ2UtYnl0ZXM=";
const CREDENTIALS = { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID };

function baseRequest(overrides: Partial<HostedImageRequest> = {}): HostedImageRequest {
  return { prompt: "a lighthouse at dusk", responseModel: "gpt-5.2", ...overrides };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseDone(): string {
  return "data: [DONE]\n\n";
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function neverEndingStreamResponse(firstChunk: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
    },
  });
  return new Response(body, { status: 200 });
}

// Standard hosted run: created, one partial preview, final image item, done.
function hostedStreamChunks(): string[] {
  return [
    sseEvent("response.created", { type: "response.created" }),
    sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      item: { type: "image_generation_call", status: "in_progress" },
    }),
    sseEvent("response.image_generation_call.partial_image", {
      type: "response.image_generation_call.partial_image",
      partial_image_b64: PARTIAL_IMAGE_B64,
      partial_image_index: 0,
    }),
    sseEvent("response.image_generation_call.completed", {
      type: "response.image_generation_call.completed",
      item: { type: "image_generation_call", result: FINAL_IMAGE_B64 },
    }),
    sseEvent("response.completed", {
      type: "response.completed",
      response: { output: [{ type: "image_generation_call", result: FINAL_IMAGE_B64 }] },
    }),
    sseDone(),
  ];
}

function requestInitOf(callIndex = 0): RequestInit {
  return mockFetch.mock.calls[callIndex][1] as RequestInit;
}

function requestBodyOf(callIndex = 0): Record<string, unknown> {
  return JSON.parse(requestInitOf(callIndex).body as string) as Record<string, unknown>;
}

async function caughtError(promise: Promise<string>): Promise<Error> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("codex-image hosted generation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // --- Request ---

  it("POSTs to the codex responses endpoint with the documented headers and signal", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(hostedStreamChunks()));
    const controller = new AbortController();

    await generateHostedImage(baseRequest(), CREDENTIALS, controller.signal);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("OpenAI-Beta")).toBe("responses=experimental");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");

    expect(init.signal).toBe(controller.signal);
  });

  it("sends the documented body with user content and the image generation tool", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(hostedStreamChunks()));

    await generateHostedImage(
      baseRequest({ inputImages: [DATA_URL] }),
      CREDENTIALS,
      new AbortController().signal,
    );

    expect(requestBodyOf()).toEqual({
      model: "gpt-5.2",
      instructions: "Use the image generation tool to create the requested image.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "a lighthouse at dusk" },
            { type: "input_image", image_url: DATA_URL },
          ],
        },
      ],
      tools: [
        {
          type: "image_generation",
          action: "auto",
          model: "gpt-image-2",
          background: "auto",
          quality: "auto",
          size: "auto",
          output_format: "png",
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: false,
      store: false,
      stream: true,
    });
  });

  it("omits input_image parts when no input images are given", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(hostedStreamChunks()));

    await generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal);

    const body = requestBodyOf();
    const input = body.input as Array<{ content: Array<unknown> }>;
    expect(input[0].content).toEqual([{ type: "input_text", text: "a lighthouse at dusk" }]);
  });

  it("passes image model, size, and quality overrides into the tool spec", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(hostedStreamChunks()));

    await generateHostedImage(
      baseRequest({ imageModel: "gpt-image-1", size: "1024x1536", quality: "high" }),
      CREDENTIALS,
      new AbortController().signal,
    );

    const body = requestBodyOf();
    expect(body.tools).toEqual([
      expect.objectContaining({ model: "gpt-image-1", size: "1024x1536", quality: "high" }),
    ]);
  });

  // --- Result selection ---

  it("returns the final item result and forwards partial previews to onPartial", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse(hostedStreamChunks()));
    const onPartial = vi.fn();

    const image = await generateHostedImage(
      baseRequest(),
      CREDENTIALS,
      new AbortController().signal,
      onPartial,
    );

    expect(image).toBe(FINAL_IMAGE_B64);
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith(PARTIAL_IMAGE_B64);
  });

  it("prefers the final result in response.completed over a partial preview", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        sseEvent("response.created", { type: "response.created" }),
        sseEvent("response.image_generation_call.partial_image", {
          type: "response.image_generation_call.partial_image",
          partial_image_b64: PARTIAL_IMAGE_B64,
          partial_image_index: 0,
        }),
        sseEvent("response.completed", {
          type: "response.completed",
          response: { output: [{ type: "image_generation_call", result: FINAL_IMAGE_B64 }] },
        }),
        sseDone(),
      ]),
    );
    const onPartial = vi.fn();

    const image = await generateHostedImage(
      baseRequest(),
      CREDENTIALS,
      new AbortController().signal,
      onPartial,
    );

    expect(image).toBe(FINAL_IMAGE_B64);
    expect(image).not.toBe(PARTIAL_IMAGE_B64);
    expect(onPartial).toHaveBeenCalledWith(PARTIAL_IMAGE_B64);
  });

  it("never returns a partial preview as the completed image", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        sseEvent("response.created", { type: "response.created" }),
        sseEvent("response.image_generation_call.partial_image", {
          type: "response.image_generation_call.partial_image",
          partial_image_b64: PARTIAL_IMAGE_B64,
          partial_image_index: 0,
        }),
        sseDone(),
      ]),
    );
    const onPartial = vi.fn();

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal, onPartial),
    );

    expect(error.message).toMatch(/final image/i);
    expect(onPartial).toHaveBeenCalledWith(PARTIAL_IMAGE_B64);
  });

  it("fails when the stream ends without any image", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([sseEvent("response.created", { type: "response.created" }), sseDone()]),
    );

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );

    expect(error.message).toMatch(/final image/i);
  });

  // --- Chunked SSE ---

  it("reassembles events and data payloads split across stream chunks", async () => {
    const streamText = hostedStreamChunks().join("");
    // Cut once inside the base64 payload and once between the two newlines of
    // an event terminator, so both a data line and a separator straddle chunks.
    const dataSplit = streamText.indexOf(PARTIAL_IMAGE_B64) + 4;
    const terminatorSplit =
      streamText.indexOf("\n\nevent: response.image_generation_call.completed") + 1;
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        streamText.slice(0, dataSplit),
        streamText.slice(dataSplit, terminatorSplit),
        streamText.slice(terminatorSplit),
      ]),
    );
    const onPartial = vi.fn();

    const image = await generateHostedImage(
      baseRequest(),
      CREDENTIALS,
      new AbortController().signal,
      onPartial,
    );

    expect(image).toBe(FINAL_IMAGE_B64);
    expect(onPartial).toHaveBeenCalledWith(PARTIAL_IMAGE_B64);
  });

  it("handles several events arriving in one chunk", async () => {
    mockFetch.mockResolvedValueOnce(streamResponse([hostedStreamChunks().join("")]));
    const onPartial = vi.fn();

    const image = await generateHostedImage(
      baseRequest(),
      CREDENTIALS,
      new AbortController().signal,
      onPartial,
    );

    expect(image).toBe(FINAL_IMAGE_B64);
    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  // --- Errors ---

  it("fails with the server message on a response.failed event", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        sseEvent("response.created", { type: "response.created" }),
        sseEvent("response.failed", {
          type: "response.failed",
          response: {
            error: { code: "content_policy_violation", message: "The prompt was rejected" },
          },
        }),
        sseDone(),
      ]),
    );

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );

    expect(error.message).toContain("The prompt was rejected");
  });

  it("fails with the server message on an error event", async () => {
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        sseEvent("response.created", { type: "response.created" }),
        sseEvent("error", { type: "error", code: "server_error", message: "upstream overloaded" }),
        sseDone(),
      ]),
    );

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );

    expect(error.message).toContain("upstream overloaded");
  });

  it("redacts image data in streamed error messages", async () => {
    const secret = "QQ".repeat(5_000);
    mockFetch.mockResolvedValueOnce(
      streamResponse([
        sseEvent("response.failed", {
          type: "response.failed",
          response: { error: { message: `Image rejected: data:image/png;base64,${secret}` } },
        }),
      ]),
    );

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );
    expect(error.message).toContain("Image rejected");
    expect(error.message).not.toContain(secret);
    expect(error.message.length).toBeLessThanOrEqual(600);
  });

  it("fails on non-2xx responses with the status and a capped error body", async () => {
    mockFetch.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );

    expect(error.message).toContain("429");
    expect(error.message).toContain("rate limited");
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  it("caps and redacts long error bodies instead of leaking image data", async () => {
    const longBase64 = "QQ".repeat(5_000);
    const bodyText = JSON.stringify({
      error: { image: `data:image/png;base64,${longBase64}`, message: "rejected" },
    });
    mockFetch.mockResolvedValueOnce(new Response(bodyText, { status: 500 }));

    const error = await caughtError(
      generateHostedImage(baseRequest(), CREDENTIALS, new AbortController().signal),
    );

    expect(error.message).toContain("500");
    expect(error.message).toContain("rejected");
    expect(error.message.length).toBeLessThanOrEqual(600);
    expect(error.message).not.toContain("data:image");
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  // --- Abort ---

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    // Emulate undici: fetch rejects immediately for an aborted signal.
    mockFetch.mockImplementation(() =>
      Promise.reject(new DOMException("This operation was aborted", "AbortError")),
    );

    await expect(
      generateHostedImage(baseRequest(), CREDENTIALS, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when aborted mid-stream", async () => {
    mockFetch.mockResolvedValueOnce(
      neverEndingStreamResponse(sseEvent("response.created", { type: "response.created" })),
    );
    const controller = new AbortController();

    const pending = generateHostedImage(baseRequest(), CREDENTIALS, controller.signal);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
