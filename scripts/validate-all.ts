import { readdirSync } from "node:fs";
import { join } from "node:path";
import { validateFile } from "../lib/validate-extension.ts";

const extensionsDir = "./extensions";
const files = readdirSync(extensionsDir, { recursive: true })
  .filter(
    (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith("_template.ts"),
  )
  .map((f) => join(extensionsDir, f));

if (files.length === 0) {
  console.log("No extensions to validate.");
  process.exit(0);
}

let allPassed = true;

for (const file of files) {
  console.log(`\nValidating ${file}...\n`);
  const result = validateFile(file);
  for (const msg of result.messages) {
    console.log(msg);
  }
  console.log("");
  if (!result.passed) {
    allPassed = false;
  }
}

if (allPassed) {
  console.log(`All ${files.length} extension(s) passed validation.`);
  process.exit(0);
} else {
  console.error("Some extensions failed validation.");
  process.exit(1);
}
