import type { ModelChoice } from "./policy.ts";

/** Provider order is an explicit preference within a model family, not a semantic routing heuristic. */
export const WORKER_TARGETS = {
  sol: ["openai-codex/gpt-6.1-sol"],
  deepseek: [
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "opencode-go/deepseek-v4.1-flash",
  ],
  glm: ["zai/glm-5.3-flash", "synthetic/hf:zai-org/GLM-5.3-Flash", "opencode-go/glm-5.3-flash"],
} as const satisfies Record<ModelChoice, readonly string[]>;

export const FAMILY_FALLBACKS = [
  { id: "glm-flash-fallback-v1", name: "GLM Flash provider fallback v1", family: "glm" },
  {
    id: "deepseek-flash-fallback-v1",
    name: "DeepSeek Flash provider fallback v1",
    family: "deepseek",
  },
] as const;

export const WORKER_PHYSICAL_MODELS: readonly string[] = Object.values(WORKER_TARGETS).flat();

export function workerFamily(modelSpec: string): ModelChoice | undefined {
  for (const family of Object.keys(WORKER_TARGETS) as ModelChoice[]) {
    if ((WORKER_TARGETS[family] as readonly string[]).includes(modelSpec)) return family;
  }
  return undefined;
}
