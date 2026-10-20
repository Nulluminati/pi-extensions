import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectBaseline, PILOT_MODELS } from "../../scripts/virtual-models-eval/baseline.ts";

const directories: string[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function setup() {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-virtual-baseline-test-"));
  directories.push(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-6.1-sol",
      defaultThinkingLevel: "medium",
      defaultTools: ["+codemode"],
      codemode: { mode: "on", inlineBudget: 3000, secret: "DO_NOT_EXPORT" },
      apiKey: "DO_NOT_EXPORT",
      packages: ["https://DO_NOT_EXPORT@example.invalid/package"],
    }),
  );
  await writeFile(join(agentDir, "auth.json"), '{"apiKey":"DO_NOT_EXPORT"}');
  await writeFile(
    join(agentDir, "worker-model.json"),
    JSON.stringify({
      provider: "zai",
      model: "glm-5.3-flash",
      thinkingLevel: "high",
      secret: "DO_NOT_EXPORT",
    }),
  );
  const catalog = PILOT_MODELS.map((spec) => ({
    ...spec,
    name: spec.id,
    api: spec.type === "classifier" ? "typesafe-system-one" : "openai-completions",
    contextWindow: 64000,
    maxTokens: 4096,
    thinkingLevelMap: { low: "low", high: "high" },
    apiKey: "DO_NOT_EXPORT",
    headers: { Authorization: "DO_NOT_EXPORT" },
  }));
  const getAvailable = vi.fn(async () => catalog);
  return { agentDir, catalog, getAvailable };
}

describe("virtual-model pilot baseline", () => {
  it("records only authenticated pilot metadata, configuration hashes, and explicit tool configuration", async () => {
    const { agentDir, getAvailable } = await setup();
    const before = await readFile(join(agentDir, "settings.json"), "utf8");
    const result = await collectBaseline({ agentDir, getAvailable, env: {} });
    expect(getAvailable).toHaveBeenCalledWith();
    expect(result.models).toHaveLength(4);
    expect(result.missingModels).toEqual([]);
    expect(result.configurations["settings.json"]).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      selection: { provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "medium" },
      tools: { defaultTools: ["+codemode"], codemode: { mode: "on", inlineBudget: 3000 } },
    });
    expect(result.configurations["worker-model.json"].selection).toEqual({
      provider: "zai",
      model: "glm-5.3-flash",
      thinkingLevel: "high",
    });
    expect(result.configurations["worker-extensions.json"]).toEqual({ sha256: null });
    expect(result.models[0]).toMatchObject({ thinkingLevelMap: { low: "low", high: "high" } });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
    expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(before);
  });

  it("reports unavailable exact IDs without substituting another authenticated GLM model", async () => {
    const { agentDir, catalog } = await setup();
    const result = await collectBaseline({
      agentDir,
      env: {},
      getAvailable: async () => [
        ...catalog.filter((model) => model.provider !== "zai"),
        { provider: "opencode-go", id: "glm-5.3", type: "chat", api: "openai-completions" },
      ],
    });
    expect(result.missingModels).toEqual(["zai/glm-5.3-flash"]);
    expect(result.models.some((model) => model.id === "glm-5.3")).toBe(false);
  });

  it("retains effective environment overrides without exporting unrelated environment values", async () => {
    const { agentDir, getAvailable } = await setup();
    const result = await collectBaseline({
      agentDir,
      getAvailable,
      env: {
        PI_WORKER_MODEL: "pilot/rules",
        PI_WORKER_MODEL_THINKING: "high",
        PI_WORKER_EXTENSIONS: "synthetic,neuralwatt,virtual-models",
        TYPESAFE_API_KEY: "DO_NOT_EXPORT",
      },
    });
    expect(result.environment).toEqual({
      PI_WORKER_MODEL: "pilot/rules",
      PI_WORKER_MODEL_THINKING: "high",
      PI_WORKER_EXTENSIONS: "synthetic,neuralwatt,virtual-models",
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
  });

  it("records catalog-time configuration changes instead of claiming unchanged configuration", async () => {
    const { agentDir, catalog } = await setup();
    const result = await collectBaseline({
      agentDir,
      env: {},
      getAvailable: async () => {
        await writeFile(join(agentDir, "settings.json"), "{}");
        return catalog;
      },
    });
    expect(result.configurationUnchanged).toBe(false);
    expect(result.changedConfigurations).toEqual(["settings.json"]);
  });

  it("rejects malformed configuration before catalog access", async () => {
    const { agentDir, getAvailable } = await setup();
    await writeFile(join(agentDir, "settings.json"), "not JSON");
    await expect(collectBaseline({ agentDir, getAvailable, env: {} })).rejects.toThrow(
      "Invalid settings.json",
    );
    expect(getAvailable).not.toHaveBeenCalled();
  });
});
