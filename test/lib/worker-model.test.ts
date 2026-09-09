import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  resolveWorkerModelSpec,
  saveWorkerModelConfig,
  WORKER_MODEL_ENV_VAR,
} from "../../lib/worker-model.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";

describe("worker-model", () => {
  let cwd: string;
  let configPath: string;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "worker-model-"));
    configPath = join(cwd, "worker-model.json");
    mockCtx = createMockContext() as DeepMocked<ExtensionContext>;
    setEnv(WORKER_MODEL_ENV_VAR, undefined);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it("explicit parameter wins over environment and config", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    saveWorkerModelConfig({ provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash" }, configPath);

    const selection = await resolveWorkerModelSpec("synthetic/hf:zai-org/GLM-5.3-Flash", mockCtx, {
      configPath,
    });

    expect(selection).toEqual({
      model: "synthetic/hf:zai-org/GLM-5.3-Flash",
      source: "explicit",
    });
  });

  it("'main' inherits the session model", async () => {
    (mockCtx as { model?: unknown }).model = {
      provider: "synthetic",
      id: "hf:zai-org/GLM-5.3-Flash",
    };

    const selection = await resolveWorkerModelSpec("main", mockCtx, { configPath });

    expect(selection).toEqual({
      model: "synthetic/hf:zai-org/GLM-5.3-Flash",
      source: "main",
    });
  });

  it("'main' throws when the session has no model", async () => {
    (mockCtx as { model?: unknown }).model = undefined;

    await expect(resolveWorkerModelSpec("main", mockCtx, { configPath })).rejects.toThrow(
      /requires the session to have a model/,
    );
  });

  it("environment variable wins over the config file", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    saveWorkerModelConfig({ provider: "synthetic", model: "other" }, configPath);

    const loaded = loadWorkerModelConfig({ configPath });

    expect(loaded).toEqual({
      config: { provider: "opencode-go", model: "glm-5.3-flash" },
      source: "environment",
    });
  });

  it("loads the config file when no environment variable is set", async () => {
    saveWorkerModelConfig({ provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash" }, configPath);

    const loaded = loadWorkerModelConfig({ configPath });

    expect(loaded).toEqual({
      config: { provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash" },
      source: "config",
    });
  });

  it("round-trips through save and load", async () => {
    saveWorkerModelConfig({ provider: "opencode-go", model: "glm-5.3-flash" }, configPath);

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw).toEqual({ provider: "opencode-go", model: "glm-5.3-flash" });
    const loaded = loadWorkerModelConfig({ configPath });
    expect(loaded.config.model).toBe("glm-5.3-flash");
  });

  it("throws a descriptive error when unconfigured", async () => {
    expect(() => loadWorkerModelConfig({ configPath })).toThrow(
      /Global worker model is not configured/,
    );
    await expect(resolveWorkerModelSpec(undefined, mockCtx, { configPath })).rejects.toThrow(
      /Run \/worker-model/,
    );
  });

  it("throws on an invalid environment spec", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "no-separator");

    expect(() => loadWorkerModelConfig({ configPath })).toThrow(/Invalid PI_WORKER_MODEL/);
  });

  it("throws on invalid explicit specs with a hint about main", async () => {
    await expect(resolveWorkerModelSpec("noslash", mockCtx, { configPath })).rejects.toThrow(
      /or "main" to inherit/,
    );
  });

  it("config path honors the override env var", () => {
    setEnv("PI_WORKER_MODEL_CONFIG", "/custom/path.json");
    expect(resolveWorkerModelConfigPath()).toBe("/custom/path.json");
    setEnv("PI_WORKER_MODEL_CONFIG", undefined);
    expect(resolveWorkerModelConfigPath()).toContain("worker-model.json");
  });

  it("writes config atomically and creates parent directories", async () => {
    const nested = join(cwd, "deep", "dir", "worker-model.json");
    saveWorkerModelConfig({ provider: "a", model: "b" }, nested);
    expect(await readFile(nested, "utf8")).toContain('"provider": "a"');
  });
});
