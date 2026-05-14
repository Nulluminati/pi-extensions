#!/usr/bin/env bun
/**
 * Validate all extensions in the extensions/ directory.
 *
 * Usage: bun test/validate-all.ts
 *
 * Excludes _template.ts (by design) and any non-.ts files.
 */

import { readdirSync } from "fs";
import { join } from "path";

const extensionsDir = "./extensions";
const files = readdirSync(extensionsDir)
  .filter((f) => f.endsWith(".ts") && f !== "_template.ts")
  .map((f) => join(extensionsDir, f));

if (files.length === 0) {
  console.log("No extensions to validate.");
  process.exit(0);
}

let allPassed = true;

for (const file of files) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "test/validate.ts", file],
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    allPassed = false;
  }

  console.log(""); // spacer
}

if (allPassed) {
  console.log(`All ${files.length} extension(s) passed validation.`);
  process.exit(0);
} else {
  console.error("Some extensions failed validation.");
  process.exit(1);
}
