import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSmallModelConfig,
  parseSmallModelSpec,
  resolveSmallModel,
  resolveSmallModelConfigPath,
  saveSmallModelConfig,
} from "../../lib/small-model.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("small-model config", () => {
  it("parses provider/model specs while preserving slashes in model ids", () => {
    expect(parseSmallModelSpec("openrouter/anthropic/claude-haiku")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku",
    });
  });

  it.each(["", "synthetic", "/model", "provider/"])("rejects invalid model spec %j", (spec) => {
    expect(parseSmallModelSpec(spec)).toBeUndefined();
  });

  it("uses the Pi agent directory by default", () => {
    expect(resolveSmallModelConfigPath({}, "/home/zero/.pi/agent")).toBe(
      "/home/zero/.pi/agent/small-model.json",
    );
  });

  it("uses a trimmed PI_SMALL_MODEL_CONFIG override", () => {
    expect(
      resolveSmallModelConfigPath({ PI_SMALL_MODEL_CONFIG: "  /tmp/pi-small.json  " }, "/ignored"),
    ).toBe("/tmp/pi-small.json");
  });

  it("loads and validates the global config file", () => {
    const path = temporaryConfigPath();
    writeFileSync(
      path,
      JSON.stringify({
        provider: "synthetic",
        model: "syn:small:text",
        thinkingLevel: "minimal",
      }),
    );

    expect(loadSmallModelConfig({ configPath: path, env: {} })).toEqual({
      config: {
        provider: "synthetic",
        model: "syn:small:text",
        thinkingLevel: "minimal",
      },
      source: "config",
    });
  });

  it("uses PI_SMALL_MODEL as a process-level override", () => {
    const path = temporaryConfigPath();
    writeFileSync(
      path,
      JSON.stringify({ provider: "synthetic", model: "syn:small:text", thinkingLevel: "low" }),
    );

    expect(
      loadSmallModelConfig({
        configPath: path,
        env: {
          PI_SMALL_MODEL: "openrouter/google/gemini-flash",
          PI_SMALL_MODEL_THINKING: "off",
        },
      }),
    ).toEqual({
      config: {
        provider: "openrouter",
        model: "google/gemini-flash",
        thinkingLevel: "off",
      },
      source: "environment",
    });
  });

  it("reports a missing config with an actionable error", () => {
    const path = temporaryConfigPath();

    expect(() => loadSmallModelConfig({ configPath: path, env: {} })).toThrow("Run /smallmodel");
  });

  it("rejects malformed config without silently falling back", () => {
    const path = temporaryConfigPath();
    writeFileSync(path, JSON.stringify({ provider: "synthetic", model: "" }));

    expect(() => loadSmallModelConfig({ configPath: path, env: {} })).toThrow(
      "Invalid global small model config",
    );
  });

  it("writes config atomically with owner-only permissions", () => {
    const path = temporaryConfigPath();

    saveSmallModelConfig(
      { provider: "synthetic", model: "syn:small:text", thinkingLevel: "minimal" },
      path,
    );

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "synthetic",
      model: "syn:small:text",
      thinkingLevel: "minimal",
    });
  });
});

describe("resolveSmallModel", () => {
  it("resolves the configured text model and credentials", async () => {
    const path = configuredPath();
    const ctx = createMockCommandContext();
    const smallModel = {
      ...ctx.model,
      id: "syn:small:text",
      provider: "synthetic",
      reasoning: true,
    };
    ctx.modelRegistry.find = vi.fn(() => smallModel);
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "small-key",
      headers: { "x-test": "yes" },
      env: { SYNTHETIC_API_KEY: "small-key" },
    }));

    const resolved = await resolveSmallModel(ctx, { configPath: path, env: {} });

    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("synthetic", "syn:small:text");
    expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(smallModel);
    expect(resolved).toEqual({
      model: smallModel,
      auth: {
        apiKey: "small-key",
        headers: { "x-test": "yes" },
        env: { SYNTHETIC_API_KEY: "small-key" },
      },
      config: {
        provider: "synthetic",
        model: "syn:small:text",
        thinkingLevel: "minimal",
      },
      source: "config",
      reasoning: "minimal",
    });
  });

  it("adds per-session routing headers for an OpenCode small model", async () => {
    const path = modelConfigPath("opencode-go", "glm-5.3-flash");
    const ctx = createMockCommandContext();
    const smallModel = {
      ...ctx.model,
      id: "glm-5.3-flash",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    };
    ctx.modelRegistry.find = vi.fn(() => smallModel);
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "opencode-key",
      headers: { "x-auth-source": "oauth" },
    }));
    ctx.sessionManager.getSessionId = vi.fn(() => "session-123");

    const resolved = await resolveSmallModel(ctx, { configPath: path, env: {} });

    expect(resolved.auth.headers).toEqual({
      "x-opencode-session": "session-123",
      "x-opencode-client": "pi",
      "x-auth-source": "oauth",
    });
  });

  it("adds OpenCode headers for a custom provider using the OpenCode host", async () => {
    const path = modelConfigPath("custom", "flash");
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => ({
      ...ctx.model,
      id: "flash",
      provider: "custom",
      baseUrl: "https://opencode.ai/custom/v1",
    }));
    ctx.sessionManager.getSessionId = vi.fn(() => "session-custom");

    const resolved = await resolveSmallModel(ctx, { configPath: path, env: {} });

    expect(resolved.auth.headers).toEqual({
      "x-opencode-session": "session-custom",
      "x-opencode-client": "pi",
    });
  });

  it("preserves explicitly configured OpenCode header overrides", async () => {
    const path = modelConfigPath("opencode", "free-model");
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => ({
      ...ctx.model,
      id: "free-model",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
    }));
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "opencode-key",
      headers: {
        "x-opencode-session": "configured-session",
        "x-opencode-client": "configured-client",
      },
    }));

    const resolved = await resolveSmallModel(ctx, { configPath: path, env: {} });

    expect(resolved.auth.headers).toEqual({
      "x-opencode-session": "configured-session",
      "x-opencode-client": "configured-client",
    });
  });

  it("does not fall back to the active model when the configured model is missing", async () => {
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => undefined);

    await expect(resolveSmallModel(ctx, { configPath: configuredPath(), env: {} })).rejects.toThrow(
      "Global small model not found",
    );
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("rejects a configured model that cannot accept text", async () => {
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => ({ ...ctx.model, input: ["image"] }));

    await expect(resolveSmallModel(ctx, { configPath: configuredPath(), env: {} })).rejects.toThrow(
      "does not accept text",
    );
  });

  it("does not fall back when the configured model has no credentials", async () => {
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => ({
      ...ctx.model,
      id: "syn:small:text",
      provider: "synthetic",
    }));
    ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: false,
      error: "no key",
    }));

    await expect(resolveSmallModel(ctx, { configPath: configuredPath(), env: {} })).rejects.toThrow(
      "No credentials for global small model",
    );
  });

  it("omits reasoning for a non-reasoning model", async () => {
    const ctx = createMockCommandContext();
    ctx.modelRegistry.find = vi.fn(() => ({
      ...ctx.model,
      id: "syn:small:text",
      provider: "synthetic",
      reasoning: false,
    }));

    const resolved = await resolveSmallModel(ctx, { configPath: configuredPath(), env: {} });

    expect(resolved.reasoning).toBeUndefined();
  });
});

function temporaryConfigPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-small-model-"));
  temporaryDirectories.push(directory);
  return join(directory, "small-model.json");
}

function configuredPath(): string {
  return modelConfigPath("synthetic", "syn:small:text");
}

function modelConfigPath(provider: string, model: string): string {
  const path = temporaryConfigPath();
  writeFileSync(
    path,
    JSON.stringify({
      provider,
      model,
      thinkingLevel: "minimal",
    }),
  );
  return path;
}
