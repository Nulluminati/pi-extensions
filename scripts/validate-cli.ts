import { validateFile } from "../lib/validate-extension.ts";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: tsx scripts/validate-cli.ts <path-to-extension.ts>");
  process.exit(1);
}

console.log(`Validating ${filePath}...\n`);
const result = validateFile(filePath);
for (const msg of result.messages) {
  console.log(msg);
}
console.log("");

if (result.passed) {
  console.log("All checks passed. Extension is ready to test with:");
  console.log(`  pi -e ${filePath}`);
  process.exit(0);
} else {
  console.error("Validation failed. Fix the issues above before committing.");
  process.exit(1);
}
