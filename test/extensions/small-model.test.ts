import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import smallModelExtension, { STATUS_ICON } from "../../extensions/small-model/small-model.ts";
import { createMockCommandContext, createMockModel } from "../mocks/context-mocks.ts";
import { mockFn } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { fakeTui, getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("small-model-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/small-model");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["small-model.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(3);
    });
  });

  it("registers the global selector command and lifecycle handlers", async () => {
    const pi = createMockPi();

    await smallModelExtension(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "smallmodel",
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("filters the model picker with a search bar and publishes the selected model", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    writeFileSync(
      path,
      JSON.stringify({
        provider: "synthetic",
        model: "syn:small:text",
        thinkingLevel: "minimal",
      }),
    );
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    const syntheticModel = createMockModel({
      id: "syn:small:text",
      name: "Synthetic Small",
      provider: "synthetic",
      reasoning: true,
    });
    const haikuModel = createMockModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
    ctx.modelRegistry.getAvailable = vi.fn(() => [syntheticModel, haikuModel]);
    ctx.modelRegistry.find = vi.fn((provider: string, model: string) =>
      provider === "anthropic" && model === "claude-haiku-4-5" ? haikuModel : undefined,
    );
    let initialRender = "";
    let filteredRender = "";
    ctx.ui.custom = mockFn(
      (factory) =>
        new Promise((resolve) => {
          const component = factory(
            fakeTui(),
            ctx.ui.theme,
            { matches: matchesPickerKey },
            resolve,
          );
          initialRender = component.render(100).join("\n");
          // pi-tui fuzzy-matches characters in order, so the query must not be a
          // subsequence of the other entry ("haiku" is).
          for (const character of "claude") component.handleInput(character);
          filteredRender = component.render(100).join("\n");
          component.handleInput("\r");
        }),
    );
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("", ctx);

    expect(initialRender.split("\n")[0]).toContain("╭── Small Model ");
    expect(initialRender.split("\n").at(-1)).toBe(`╰${"─".repeat(98)}╯`);
    expect(initialRender).not.toContain("Select Global Small Model");
    expect(initialRender).toContain("Search");
    expect(initialRender).toContain("synthetic/syn:small:text");
    expect(initialRender).not.toContain("(active)");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "synthetic/syn:small:text");
    expect(initialRender).toContain("anthropic/claude-haiku-4-5");
    expect(initialRender).toContain("Claude Haiku 4.5 · 200k ctx · 64k out · image · reasoning");
    expect(filteredRender).toContain("anthropic/claude-haiku-4-5");
    expect(filteredRender).not.toContain("synthetic/syn:small:text");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      thinkingLevel: "minimal",
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "small-model",
      expect.stringContaining(STATUS_ICON),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "small-model",
      expect.stringContaining("anthropic/claude-haiku-4-5"),
    );
  });

  it("uses the standard selector outside TUI mode", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.mode = "rpc";
    const smallModel = createMockModel({
      id: "syn:small:text",
      provider: "synthetic",
      reasoning: true,
    });
    ctx.modelRegistry.getAvailable = vi.fn(() => [smallModel]);
    ctx.modelRegistry.find = vi.fn(() => smallModel);
    ctx.ui.select = vi.fn(async (_title, options) => options[0]);
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("", ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("Select Global Small Model", [
      "synthetic/syn:small:text",
    ]);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "synthetic",
      model: "syn:small:text",
      thinkingLevel: "minimal",
    });
  });

  it("sets a model directly and accepts a thinking level", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    const smallModel = createMockModel({
      id: "google/gemini-flash",
      provider: "openrouter",
      reasoning: true,
    });
    ctx.modelRegistry.find = vi.fn(() => smallModel);
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("openrouter/google/gemini-flash low", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "openrouter",
      model: "google/gemini-flash",
      thinkingLevel: "low",
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Global small model set to openrouter/google/gemini-flash (low).",
      "info",
    );
  });

  it("changes only the thinking level with the thinking subcommand", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    writeFileSync(
      path,
      JSON.stringify({
        provider: "opencode-go",
        model: "deepseek-flash",
        thinkingLevel: "minimal",
      }),
    );
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() =>
      createMockModel({
        provider: "opencode-go",
        id: "deepseek-flash",
        reasoning: true,
      }),
    );
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("thinking high", ctx);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "opencode-go",
      model: "deepseek-flash",
      thinkingLevel: "high",
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Global small model set to opencode-go/deepseek-flash (high).",
      "info",
    );
  });

  it("reports the missing config when only the thinking level is requested", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("thinking high", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not configured"), "error");
    expect(() => readFileSync(path)).toThrow();
  });

  it("rejects unavailable models without changing the config", async () => {
    const path = configPath();
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => undefined);
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("missing/nope", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Global small model not found: missing/nope"),
      "error",
    );
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("shows the environment override and refuses to replace it", async () => {
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", configPath());
    vi.stubEnv("PI_SMALL_MODEL", "synthetic/syn:small:text");
    vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() =>
      createMockModel({
        id: "syn:small:text",
        provider: "synthetic",
        reasoning: true,
      }),
    );
    await smallModelExtension(pi);

    await getCommandHandler(pi, "smallmodel")("openrouter/google/gemini-flash", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("PI_SMALL_MODEL is overriding"),
      "warning",
    );
  });

  it("session_start publishes a configuration error instead of the active model", async () => {
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", configPath());
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await smallModelExtension(pi);

    await getEventHandler(pi, "session_start")({ type: "session_start", reason: "startup" }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "small-model",
      expect.stringContaining("not configured"),
    );
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
      "small-model",
      expect.stringContaining("test-provider/test-model"),
    );
  });

  it("updates the status when another process changes the config file", async () => {
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({ provider: "synthetic", model: "first-small", thinkingLevel: "minimal" }),
    );
    vi.stubEnv("PI_SMALL_MODEL_CONFIG", path);
    vi.stubEnv("PI_SMALL_MODEL", "");
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn((provider: string, model: string) =>
      createMockModel({
        provider,
        id: model,
        reasoning: true,
      }),
    );
    await smallModelExtension(pi);
    const sessionStart = getEventHandler(pi, "session_start");
    const sessionShutdown = getEventHandler(pi, "session_shutdown");
    await sessionStart({ type: "session_start", reason: "startup" }, ctx);
    ctx.ui.setStatus.mockClear();

    writeFileSync(
      path,
      JSON.stringify({ provider: "synthetic", model: "second-small", thinkingLevel: "low" }),
    );

    await vi.waitFor(() =>
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "small-model",
        expect.stringContaining("synthetic/second-small"),
      ),
    );
    await sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  });

  it("session_shutdown clears the status", async () => {
    const pi = createMockPi();
    const ctx = createMockCommandContext();
    await smallModelExtension(pi);

    await getEventHandler(pi, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("small-model", undefined);
  });
});

function matchesPickerKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\u001b", "\u0003"],
  };
  return keys[keybinding]?.includes(data) ?? false;
}

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-small-model-extension-"));
  temporaryDirectories.push(directory);
  return join(directory, "small-model.json");
}
