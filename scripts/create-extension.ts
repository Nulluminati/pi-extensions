/**
 * Create a new Pi extension from boilerplate.
 *
 * Usage: tsx scripts/create-extension.ts <name>
 *
 * Creates:
 *   - extensions/<name>/<name>.ts
 *   - test/extensions/<name>.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSIONS_DIR = "./extensions";
const TEST_DIR = "./test/extensions";

const name = process.argv[2];

if (!name) {
  console.error("Usage: tsx scripts/create-extension.ts <name>");
  console.error("Example: tsx scripts/create-extension.ts my-feature");
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Invalid extension name: "${name}". Use lowercase kebab-case (e.g. my-feature).`);
  process.exit(1);
}

const extDir = join(EXTENSIONS_DIR, name);
const extFile = join(extDir, `${name}.ts`);
const testFile = join(TEST_DIR, `${name}.test.ts`);

// --- Extension boilerplate ---

const extTemplate = `/**
 * ${name} Extension
 *
 * Short description of what this extension does.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "pi";

// --- Constants ---

const WIDGET_KEY = "${name}";

// --- Extension factory ---

export default async function ${toCamelCase(name)}Extension(pi: ExtensionAPI) {
\t// Register a slash command
\tpi.registerCommand("${name}", {
\t\tdescription: "Description of what /${name} does",
\t\thandler: async (args: string, ctx: ExtensionCommandContext) => {
\t\t\tconst input = args.trim();
\t\t\tif (!input) {
\t\t\t\tctx.ui.notify("Usage: /${name} <args>", "warning");
\t\t\t\treturn;
\t\t\t}
\t\t\tctx.ui.notify(\`${name}: received "\${input}"\`, "info");
\t\t},
\t});
}
`;

// --- Test boilerplate ---

const testTemplate = `import { beforeEach, describe, expect, it, vi } from "vitest";
import ${toCamelCase(name)}Extension from "../../extensions/${name}/${name}.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

describe("${name}-extension", () => {
\tbeforeEach(() => {
\t\tvi.resetAllMocks();
\t});

\tit("registers /${name} command", async () => {
\t\tconst mockPi = createMockPi();
\t\tawait ${toCamelCase(name)}Extension(mockPi);
\t\texpect(mockPi.registerCommand).toHaveBeenCalledWith(
\t\t\t"${name}",
\t\t\texpect.objectContaining({
\t\t\t\tdescription: expect.any(String),
\t\t\t\thandler: expect.any(Function),
\t\t\t}),
\t\t);
\t});

\tit("/${name} with no args shows usage", async () => {
\t\tconst mockPi = createMockPi();
\t\tconst mockCtx = createMockCommandContext();
\t\tawait ${toCamelCase(name)}Extension(mockPi);
\t\tconst handler = mockPi.registerCommand.mock.calls[0][1].handler;
\t\tawait handler("", mockCtx);
\t\texpect(mockCtx.ui.notify).toHaveBeenCalledWith(
\t\t\texpect.stringContaining("Usage"),
\t\t\t"warning",
\t\t);
\t});

\tit("/${name} with args notifies", async () => {
\t\tconst mockPi = createMockPi();
\t\tconst mockCtx = createMockCommandContext();
\t\tawait ${toCamelCase(name)}Extension(mockPi);
\t\tconst handler = mockPi.registerCommand.mock.calls[0][1].handler;
\t\tawait handler("test input", mockCtx);
\t\texpect(mockCtx.ui.notify).toHaveBeenCalledWith(
\t\t\texpect.stringContaining("test input"),
\t\t\t"info",
\t\t);
\t});
});
`;

// --- Create files ---

mkdirSync(extDir, { recursive: true });
writeFileSync(extFile, extTemplate);
writeFileSync(testFile, testTemplate);

console.log(`Created extension:  ${extFile}`);
console.log(`Created test:       ${testFile}`);
console.log("");
console.log("Next steps:");
console.log(`  1. Edit ${extFile}`);
console.log(`  2. Run: npm run validate:one ${extFile}`);
console.log(`  3. Test live: pi -e ${extFile}`);
console.log("  4. Run: npm run check");

// --- Helpers ---

function toCamelCase(kebab: string): string {
  return kebab
    .split("-")
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}
