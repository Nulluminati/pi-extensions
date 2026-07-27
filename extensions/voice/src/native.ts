import { createRequire } from "node:module";
import type { OnnxRuntime, SherpaOnnx } from "./types.ts";

// --- Native addon loading ---

export function loadSherpa(): SherpaOnnx {
  // createRequire is required for native .node addons; Node caches the module
  // so repeated calls are instant.
  const require = createRequire(import.meta.url);
  return require("sherpa-onnx-node") as SherpaOnnx;
}

export function loadOnnxRuntime(): OnnxRuntime {
  const require = createRequire(import.meta.url);
  return require("onnxruntime-node") as OnnxRuntime;
}
