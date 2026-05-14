#!/usr/bin/env bun
/**
 * Extension validator for pi-extensions.
 *
 * Usage: bun test/validate.ts extensions/<name>.ts
 *
 * Checks:
 * - Valid TypeScript syntax (via Bun transpiler)
 * - Default export exists
 * - Default export is an async function
 * - No undeclared npm imports (relative and pi API imports are OK)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: bun test/validate.ts <path-to-extension.ts>");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

let failed = false;

function error(msg: string) {
  console.error(`  ❌ ${msg}`);
  failed = true;
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

console.log(`Validating ${filePath}...\n`);

// Strip comments for analysis (not for transpilation check)
function stripComments(code: string): string {
  return code
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const source = readFileSync(filePath, "utf-8");
const sourceWithoutComments = stripComments(source);
try {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  transpiler.scan(source); // Just parse, don't need the output
  ok("TypeScript syntax is valid");
} catch (e: any) {
  error(`TypeScript syntax error: ${e.message || e}`);
}

// 2. Check for default export
const hasDefaultExport =
  /export\s+default\s+/.test(sourceWithoutComments) ||
  /export\s+\{[^}]*default[^}]*\}/.test(sourceWithoutComments);

if (hasDefaultExport) {
  ok("Has a default export");
} else {
  error("Missing default export. Extensions must export a default async function.");
}

// 3. Check default export is an async function
const hasAsyncFunction =
  /export\s+default\s+async\s+function/.test(sourceWithoutComments) ||
  /export\s+default\s+async\s*\(/.test(sourceWithoutComments) ||
  /export\s+default\s+.*=>/.test(sourceWithoutComments);

if (hasAsyncFunction) {
  ok("Default export is an async function");
} else {
  error("Default export should be an async function");
}

// 4. Check for undeclared npm imports (not relative, not pi API)
const importRegex = /import\s+.*?\s+from\s+["']([^"']+)["']/g;
const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const allowedImports = /^\./; // relative imports are OK
const disallowedImports: string[] = [];

let match: RegExpExecArray | null;
while ((match = importRegex.exec(sourceWithoutComments)) !== null) {
  const mod = match[1];
  if (!allowedImports.test(mod) && mod !== "pi") {
    disallowedImports.push(mod);
  }
}
while ((match = dynamicImportRegex.exec(sourceWithoutComments)) !== null) {
  const mod = match[1];
  if (!allowedImports.test(mod) && mod !== "pi") {
    disallowedImports.push(mod);
  }
}

if (disallowedImports.length === 0) {
  ok("No undeclared npm imports (relative imports only)");
} else {
  error(
    `Undeclared imports detected: ${disallowedImports.join(", ")}. ` +
    `If you need external dependencies, add them to extensions/package.json and document why.`
  );
}

// 5. Check for pi API usage (at least one pi.registerTool, pi.registerCommand, or pi.on)
const hasPiApi =
  /pi\.registerTool\s*\(/.test(sourceWithoutComments) ||
  /pi\.registerCommand\s*\(/.test(sourceWithoutComments) ||
  /pi\.on\s*\(/.test(sourceWithoutComments) ||
  /pi\.appendEntry\s*\(/.test(sourceWithoutComments);

if (hasPiApi) {
  ok("Uses pi API (registerTool, registerCommand, on, or appendEntry)");
} else {
  error("Extension does not appear to use any pi APIs. It won't do anything.");
}

console.log("");
if (failed) {
  console.error("Validation failed. Fix the issues above before committing.");
  process.exit(1);
} else {
  console.log("All checks passed. Extension is ready to test with:");
  console.log(`  pi -e ${filePath}`);
  process.exit(0);
}
