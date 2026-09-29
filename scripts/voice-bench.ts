// Integration check: exercises the extension's own transcribeFile + config
// builders against the real sherpa-onnx-node addon and the downloaded models
// on this machine. Not a test file; run with: npx tsx scripts/voice-bench.ts
import { createRequire } from "node:module";
import { resolveModelsDir } from "../extensions/voice/src/config.ts";
import { MODELS } from "../extensions/voice/src/models.ts";
import { transcribeFile } from "../extensions/voice/src/transcription.ts";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const modelsDir = resolveModelsDir(process.env);
const wav = `${modelsDir}/sherpa-onnx-whisper-tiny.en/test_wavs/0.wav`;

console.log(`models dir: ${modelsDir}\nwav: ${wav}\n`);
for (const model of MODELS) {
  const result = transcribeFile(sherpa, model, modelsDir, wav);
  console.log(
    `${model.id.padEnd(24)} audio ${result.durationSec.toFixed(2)}s | decode ${result.elapsedSec.toFixed(2)}s | RTF ${result.rtf.toFixed(3)}`,
  );
  console.log(`  text: ${result.text.slice(0, 80)}${result.text.length > 80 ? "…" : ""}`);
}
