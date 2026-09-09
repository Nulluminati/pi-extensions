import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import workerModelExtension, { STATUS_ICON } from "../../extensions/worker-model/worker-model.ts";
import { createMockCommandContext, createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worker-model-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "worker-model.json");
}

describe("worker-model-extension", () => {
  it("registers the command and lifecycle handlers", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    await workerModelExtension(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "worker-model",
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("filters the model picker and publishes the selected worker model", async () => {
    const path = configPath();
    vi.stubEnv("PI_WORKER_MODEL_CONFIG", path);
    vi.stubEnv("PI_WORKER_MODEL", "");
    writeFileSync(path, JSON.stringify({ provider: "opencode-go", model: "glm-5.3-flash" }));
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    const flashModel = {
      ...ctx.model,
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      provider: "opencode-go",
      reasoning: true,
    };
    const haikuModel = {
      ...ctx.model,
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    ctx.modelRegistry.getAvailable = vi.fn(() => [flashModel, haikuModel]);

    let initialRender = "";
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender: vi.fn() },
            ctx.ui.theme,
            { matches: matchesPickerKey },
            resolve,
          );
          initialRender = component.render(100).join("\n");
          for (const character of "haiku") component.handleInput(character);
          component.render(100);
          component.handleInput("\r");
        }),
    );
    await workerModelExtension(pi);

    await getCommandHandler(pi, "worker-model")("", ctx);

    expect(initialRender.split("\n")[0]).toContain("╭── Worker Model ");
    expect(initialRender).toContain("opencode-go/glm-5.3-flash");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("sets a model directly from command arguments", async () => {
    const path = configPath();
    vi.stubEnv("PI_WORKER_MODEL_CONFIG", path);
    vi.stubEnv("PI_WORKER_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.modelRegistry.getAvailable = vi.fn(() => [ctx.model]);
    await workerModelExtension(pi);

    await getCommandHandler(pi, "worker-model")("synthetic/hf:zai-org/GLM-5.3-Flash", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "synthetic",
      model: "hf:zai-org/GLM-5.3-Flash",
    });
  });

  it("warns and keeps the config when PI_WORKER_MODEL overrides it", async () => {
    const path = configPath();
    vi.stubEnv("PI_WORKER_MODEL_CONFIG", path);
    vi.stubEnv("PI_WORKER_MODEL", "opencode-go/glm-5.3-flash");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerModelExtension(pi);

    await getCommandHandler(pi, "worker-model")("synthetic/other", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("PI_WORKER_MODEL is overriding"),
      "warning",
    );
    expect(() => readFileSync(path)).toThrow();
  });

  it("status reports the configured model or the unconfigured error", async () => {
    const path = configPath();
    vi.stubEnv("PI_WORKER_MODEL_CONFIG", path);
    vi.stubEnv("PI_WORKER_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await workerModelExtension(pi);

    await getCommandHandler(pi, "worker-model")("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "error");

    const { saveWorkerModelConfig } = await import("../../lib/worker-model.ts");
    saveWorkerModelConfig({ provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash" }, path);

    await getCommandHandler(pi, "worker-model")("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("synthetic/hf:zai-org/GLM-5.3-Flash"),
      "info",
    );
  });

  it("publishes a status line on session start and clears it on shutdown", async () => {
    const path = configPath();
    vi.stubEnv("PI_WORKER_MODEL_CONFIG", path);
    vi.stubEnv("PI_WORKER_MODEL", "");
    const { saveWorkerModelConfig } = await import("../../lib/worker-model.ts");
    saveWorkerModelConfig({ provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash" }, path);
    const pi = createMockPi();
    const ctx = createMockContext();
    await workerModelExtension(pi);

    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "worker-model",
      expect.stringContaining("synthetic/hf:zai-org/GLM-5.3-Flash"),
    );

    await getEventHandler(pi, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("worker-model", undefined);
  });

  it("exports a distinct status icon", () => {
    expect(STATUS_ICON).not.toBe("");
  });
});

function matchesPickerKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\u001b"],
  };
  return (keys[keybinding] ?? []).includes(data);
}
