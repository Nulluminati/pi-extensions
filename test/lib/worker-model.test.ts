import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkerModelConfig,
  resolveWorkerModelConfigPath,
  resolveWorkerModelSpec,
  saveWorkerModelConfig,
  WORKER_MODEL_ENV_VAR,
} from "../../lib/worker-model.ts";

describe("worker-model", () => {
  let cwd: string;
  let configPath: string;
  const oldEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "worker-model-"));
    configPath = join(cwd, "worker-model.json");
    setEnv(WORKER_MODEL_ENV_VAR, undefined);
    setEnv("PI_WORKER_MODEL_THINKING", undefined);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it("resolves the environment model and default thinking instead of the saved config", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    await saveWorkerModelConfig(
      { provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash", thinkingLevel: "low" },
      configPath,
    );

    const selection = await resolveWorkerModelSpec({ configPath });

    expect(selection).toEqual({
      model: "opencode-go/glm-5.3-flash",
      thinkingLevel: "high",
      source: "environment",
    });
  });

  it("resolves the saved model and thinking level when the environment is unset", async () => {
    await saveWorkerModelConfig(
      { provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash", thinkingLevel: "xhigh" },
      configPath,
    );

    const selection = await resolveWorkerModelSpec({ configPath });

    expect(selection).toEqual({
      model: "synthetic/hf:zai-org/GLM-5.3-Flash",
      thinkingLevel: "xhigh",
      source: "config",
    });
  });

  it("environment variable wins over the config file", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    await saveWorkerModelConfig(
      { provider: "synthetic", model: "other", thinkingLevel: "low" },
      configPath,
    );

    const loaded = loadWorkerModelConfig({ configPath });

    expect(loaded).toEqual({
      config: { provider: "opencode-go", model: "glm-5.3-flash", thinkingLevel: "high" },
      source: "environment",
    });
  });

  it("loads the config file when no environment variable is set", async () => {
    await saveWorkerModelConfig(
      { provider: "synthetic", model: "hf:zai-org/GLM-5.3-Flash", thinkingLevel: "medium" },
      configPath,
    );

    const loaded = loadWorkerModelConfig({ configPath });

    expect(loaded).toEqual({
      config: {
        provider: "synthetic",
        model: "hf:zai-org/GLM-5.3-Flash",
        thinkingLevel: "medium",
      },
      source: "config",
    });
  });

  it("loads the worker thinking level from the environment", () => {
    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    setEnv("PI_WORKER_MODEL_THINKING", "xhigh");

    expect(loadWorkerModelConfig({ configPath }).config.thinkingLevel).toBe("xhigh");
  });

  it("defaults legacy config files without a thinking level to high", async () => {
    await writeFile(configPath, JSON.stringify({ provider: "synthetic", model: "legacy" }));

    expect(loadWorkerModelConfig({ configPath, env: {} }).config.thinkingLevel).toBe("high");
  });

  it("round-trips through save and load", async () => {
    await saveWorkerModelConfig(
      { provider: "opencode-go", model: "glm-5.3-flash", thinkingLevel: "high" },
      configPath,
    );

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw).toEqual({
      provider: "opencode-go",
      model: "glm-5.3-flash",
      thinkingLevel: "high",
    });
    const loaded = loadWorkerModelConfig({ configPath });
    expect(loaded.config.model).toBe("glm-5.3-flash");
  });

  it("throws a descriptive error when unconfigured", async () => {
    expect(() => loadWorkerModelConfig({ configPath })).toThrow(
      /Global worker model is not configured/,
    );
    await expect(resolveWorkerModelSpec({ configPath })).rejects.toThrow(/Run \/worker-model/);
  });

  it("throws on an invalid environment spec or thinking level", async () => {
    setEnv(WORKER_MODEL_ENV_VAR, "no-separator");
    expect(() => loadWorkerModelConfig({ configPath })).toThrow(/Invalid PI_WORKER_MODEL/);

    setEnv(WORKER_MODEL_ENV_VAR, "opencode-go/glm-5.3-flash");
    setEnv("PI_WORKER_MODEL_THINKING", "extreme");
    expect(() => loadWorkerModelConfig({ configPath })).toThrow(/Invalid PI_WORKER_MODEL_THINKING/);
  });

  it("rejects an invalid thinking level in the config file", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ provider: "synthetic", model: "worker", thinkingLevel: "extreme" }),
    );

    expect(() => loadWorkerModelConfig({ configPath, env: {} })).toThrow(/Invalid thinkingLevel/);
  });

  it("config path honors the override env var", () => {
    setEnv("PI_WORKER_MODEL_CONFIG", "/custom/path.json");
    expect(resolveWorkerModelConfigPath()).toBe("/custom/path.json");
    setEnv("PI_WORKER_MODEL_CONFIG", undefined);
    expect(resolveWorkerModelConfigPath()).toContain("worker-model.json");
  });

  it("writes config atomically and creates parent directories", async () => {
    const nested = join(cwd, "deep", "dir", "worker-model.json");
    await saveWorkerModelConfig({ provider: "a", model: "b", thinkingLevel: "high" }, nested);
    expect(await readFile(nested, "utf8")).toContain('"provider": "a"');
  });

  it("keeps the config file owner-only readable", async () => {
    await saveWorkerModelConfig({ provider: "a", model: "b", thinkingLevel: "high" }, configPath);

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
