import { beforeEach, describe, expect, it, vi } from "vitest";
import codexImageExtension from "../../extensions/codex-image/codex-image.ts";
import { getCodexCredentials } from "../../extensions/codex-image/src/auth.ts";
import { getCodexResponseModel } from "../../extensions/codex-image/src/config.ts";
import { generateHostedImage } from "../../extensions/codex-image/src/hosted.ts";
import { loadInputImages, saveImage } from "../../extensions/codex-image/src/output.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

vi.mock("../../extensions/codex-image/src/auth.ts", () => ({ getCodexCredentials: vi.fn() }));
vi.mock("../../extensions/codex-image/src/config.ts", () => ({ getCodexResponseModel: vi.fn() }));
vi.mock("../../extensions/codex-image/src/hosted.ts", () => ({ generateHostedImage: vi.fn() }));
vi.mock("../../extensions/codex-image/src/output.ts", () => ({
  loadInputImages: vi.fn(),
  saveImage: vi.fn(),
}));

function registeredTool() {
  const pi = createMockPi();
  void codexImageExtension(pi);
  expect(pi.registerTool).toHaveBeenCalledTimes(1);
  return pi.registerTool.mock.calls[0][0];
}

describe("codex-image extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCodexCredentials).mockResolvedValue({
      accessToken: "test-token",
      accountId: "test-account",
    });
    vi.mocked(getCodexResponseModel).mockResolvedValue("gpt-5.2-codex");
    vi.mocked(loadInputImages).mockResolvedValue([]);
    vi.mocked(generateHostedImage).mockResolvedValue("cG5n");
    vi.mocked(saveImage).mockResolvedValue("/project/.pi/images/sunrise-abc.png");
  });

  it("registers one model-facing tool and no command", async () => {
    const pi = createMockPi();
    await codexImageExtension(pi);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.registerTool.mock.calls[0][0].name).toBe("generate_image");
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });

  it("generates an image, writes it, and returns the image and path", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    ctx.cwd = "/project";
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const result = await tool.execute("call-1", { prompt: "sunrise" }, signal, onUpdate, ctx);

    expect(getCodexCredentials).toHaveBeenCalledWith(signal);
    expect(getCodexResponseModel).toHaveBeenCalledWith();
    expect(loadInputImages).not.toHaveBeenCalled();
    expect(generateHostedImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "sunrise", responseModel: "gpt-5.2-codex" }),
      { accessToken: "test-token", accountId: "test-account" },
      signal,
      expect.any(Function),
    );
    expect(saveImage).toHaveBeenCalledWith("cG5n", "/project", "sunrise");
    expect(result.content).toEqual([
      { type: "text", text: "Image saved to /project/.pi/images/sunrise-abc.png" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
    expect(result.details).toEqual({ path: "/project/.pi/images/sunrise-abc.png" });
    expect(result.terminate).toBeUndefined();
  });

  it("forwards up to five image references for editing", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    ctx.cwd = "/project";
    vi.mocked(loadInputImages).mockResolvedValue(["data:image/png;base64,AAAA"]);
    await tool.execute(
      "call-2",
      {
        prompt: "change the sky",
        inputImages: ["reference.png"],
        size: "1024x1024",
        quality: "low",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(loadInputImages).toHaveBeenCalledWith(["reference.png"], "/project");
    expect(generateHostedImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "change the sky",
        inputImages: ["data:image/png;base64,AAAA"],
        size: "1024x1024",
        quality: "low",
      }),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("reports partial images without including base64 in text updates", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    const onUpdate = vi.fn();
    vi.mocked(generateHostedImage).mockImplementation(
      async (_request, _auth, _signal, onPartial) => {
        onPartial?.("partial-base64");
        return "cG5n";
      },
    );
    await tool.execute("call-3", { prompt: "star" }, undefined, onUpdate, ctx);
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "image", data: "partial-base64", mimeType: "image/png" }],
    });
  });

  it("rejects empty prompts and too many input images before authentication", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    await expect(
      tool.execute("empty", { prompt: "   " }, undefined, undefined, ctx),
    ).rejects.toThrow(/prompt/i);
    await expect(
      tool.execute(
        "many",
        { prompt: "edit", inputImages: Array(6).fill("image.png") },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow(/five|5/i);
    expect(getCodexCredentials).not.toHaveBeenCalled();
  });

  it("retries with a supported response model when Codex rejects the configured model", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    vi.mocked(generateHostedImage)
      .mockRejectedValueOnce(
        new Error(
          "ChatGPT image generation request failed (HTTP 400): The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
        ),
      )
      .mockResolvedValueOnce("cG5n");

    const result = await tool.execute("fallback", { prompt: "sky" }, undefined, undefined, ctx);
    expect(generateHostedImage).toHaveBeenCalledTimes(2);
    expect(generateHostedImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ responseModel: "gpt-5.2-codex" }),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(generateHostedImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ responseModel: "gpt-5.5" }),
      expect.any(Object),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(result.details).toEqual({ path: "/project/.pi/images/sunrise-abc.png" });
  });

  it("propagates auth and transport failures instead of returning success", async () => {
    const tool = registeredTool();
    const ctx = createMockCommandContext();
    vi.mocked(getCodexCredentials).mockRejectedValueOnce(new Error("Run codex login"));
    await expect(
      tool.execute("auth", { prompt: "sky" }, undefined, undefined, ctx),
    ).rejects.toThrow("Run codex login");
    vi.mocked(generateHostedImage).mockRejectedValueOnce(new Error("Codex response failed"));
    await expect(
      tool.execute("network", { prompt: "sky" }, undefined, undefined, ctx),
    ).rejects.toThrow("Codex response failed");
    expect(saveImage).not.toHaveBeenCalled();
  });
});
