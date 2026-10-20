/** Capture pilot provenance without sending model requests or exporting credentials. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { excludeFromGit, runGit } from "../../lib/git.ts";
import { writeJsonAtomic } from "../../lib/json-atomic.ts";
import { projectStateDir, projectStateRelative } from "../../lib/paths.ts";

export const PILOT_MODELS = [
  { provider: "openai-codex", id: "gpt-6.1-sol", type: "chat" },
  { provider: "opencode-go", id: "deepseek-v4.1-flash", type: "chat" },
  { provider: "zai", id: "glm-5.3-flash", type: "chat" },
  { provider: "typesafe", id: "jev-latest", type: "classifier" },
] as const;

const CONFIGURATION_FILES = [
  "settings.json",
  "models.json",
  "auth.json",
  "worker-model.json",
  "worker-extensions.json",
  "small-model.json",
] as const;
const ENVIRONMENT_KEYS = [
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_WORKER_MODEL",
  "PI_WORKER_MODEL_THINKING",
  "PI_WORKER_MODEL_CONFIG",
  "PI_WORKER_EXTENSIONS",
  "PI_WORKER_EXTENSIONS_CONFIG",
] as const;

interface CatalogModel {
  provider: string;
  id: string;
  type?: string;
  name?: string;
  api: string;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

interface ConfigurationSnapshot {
  sha256: string | null;
  selection?: Record<string, string>;
  tools?: { defaultTools?: string[]; codemode?: Record<string, string | number> };
  extensions?: string[];
}

type Configurations = Record<string, ConfigurationSnapshot>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

async function configurations(agentDir: string): Promise<Configurations> {
  const result: Configurations = {};
  for (const name of CONFIGURATION_FILES) {
    let source: string;
    try {
      source = await readFile(join(agentDir, name), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        result[name] = { sha256: null };
        continue;
      }
      throw error;
    }
    const snapshot: ConfigurationSnapshot = {
      sha256: createHash("sha256").update(source).digest("hex"),
    };
    result[name] = snapshot;
    // Auth and endpoint files contribute only their hashes. Never parse or copy their contents.
    if (!["settings.json", "worker-model.json", "worker-extensions.json"].includes(name)) continue;
    try {
      const parsed: unknown = JSON.parse(source);
      if (name === "worker-extensions.json") {
        const extensions = strings(parsed);
        if (!extensions) throw new Error("Expected extension names");
        snapshot.extensions = extensions;
        continue;
      }
      const config = object(parsed);
      const selection: Record<string, string> = {};
      for (const key of ["provider", "model", "thinkingLevel"]) {
        const field =
          name === "settings.json" ? `default${key[0]?.toUpperCase()}${key.slice(1)}` : key;
        if (typeof config[field] === "string") selection[key] = config[field];
      }
      snapshot.selection = selection;
      if (name !== "settings.json") continue;
      snapshot.tools = {};
      const defaultTools = strings(config.defaultTools);
      if (defaultTools) snapshot.tools.defaultTools = defaultTools;
      if (config.codemode !== undefined) {
        const codemode = object(config.codemode);
        snapshot.tools.codemode = {};
        if (typeof codemode.mode === "string") snapshot.tools.codemode.mode = codemode.mode;
        if (typeof codemode.inlineBudget === "number")
          snapshot.tools.codemode.inlineBudget = codemode.inlineBudget;
      }
    } catch {
      // Parser errors can quote input fragments containing credentials.
      throw new Error(`Invalid ${name}; expected valid configuration JSON`);
    }
  }
  return result;
}

export async function collectBaseline(options: {
  agentDir: string;
  getAvailable: () => Promise<readonly CatalogModel[]>;
  env: NodeJS.ProcessEnv;
}) {
  const before = await configurations(options.agentDir);
  const available = await options.getAvailable();
  const models: CatalogModel[] = [];
  const missingModels: string[] = [];
  for (const spec of PILOT_MODELS) {
    const model = available.find(
      (entry) =>
        entry.provider === spec.provider && entry.id === spec.id && entry.type === spec.type,
    );
    if (!model) {
      missingModels.push(`${spec.provider}/${spec.id}`);
      continue;
    }
    // Construct a metadata-only object; catalog models can contain request headers and keys.
    models.push({
      ...spec,
      api: model.api,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    });
  }
  const after = await configurations(options.agentDir);
  const changedConfigurations = CONFIGURATION_FILES.filter(
    (name) => before[name]?.sha256 !== after[name]?.sha256,
  );
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    models,
    missingModels,
    configurations: before,
    configurationUnchanged: changedConfigurations.length === 0,
    changedConfigurations,
    environment: Object.fromEntries(
      ENVIRONMENT_KEYS.flatMap((key) =>
        options.env[key] === undefined ? [] : [[key, options.env[key]]],
      ),
    ),
    limitations: [
      "Authenticated catalog availability does not verify inference or remaining quota.",
      "Saved tool settings are not an effective session tool inventory.",
      "Main and worker launchers must still record effective physical thinking levels and tool exposure.",
      "External configuration paths in environment overrides require separate hashes before live runs.",
    ],
  };
}

async function main() {
  if (process.argv.length > 2)
    throw new Error("Usage: node --import tsx scripts/virtual-models-eval/baseline.ts");
  const repository = resolve(import.meta.dirname, "../..");
  const commit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
  const status = await runGit(repository, ["status", "--porcelain"]);
  const { stdout: version } = await promisify(execFile)("pi", ["--version"]);
  const baseline = await collectBaseline({
    agentDir: getAgentDir(),
    env: process.env,
    async getAvailable() {
      const registry = new ModelRegistry(await ModelRuntime.create());
      return [
        ...(await registry.getAvailableOfType("chat")),
        ...(await registry.getAvailableOfType("classifier")),
      ];
    },
  });
  const directory = join(
    projectStateDir(repository, "virtual-models-eval"),
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await excludeFromGit(repository, `${projectStateRelative("virtual-models-eval")}/`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "baseline.json");
  await writeJsonAtomic(
    path,
    {
      ...baseline,
      piVersion: version.trim(),
      nodeVersion: process.version,
      commit,
      worktreeStatus: status,
    },
    { mode: 0o600 },
  );
  console.log(`Baseline: ${path}`);
  console.log(
    `Pilot models available: ${baseline.models.length}/${PILOT_MODELS.length}; configuration unchanged: ${baseline.configurationUnchanged}`,
  );
  if (baseline.missingModels.length || !baseline.configurationUnchanged) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
