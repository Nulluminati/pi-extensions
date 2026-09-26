/**
 * Filesystem-convention enforcement.
 *
 * Extension state resolves through lib/paths.ts so PI_CODING_AGENT_DIR,
 * XDG_CACHE_HOME, and a rebranded CONFIG_DIR_NAME are honored. The entrypoint
 * validator never parses src/ modules, so this walks every source file's AST.
 * An AST scan rather than a text grep because user-facing strings legitimately
 * mention Pi's own paths (`~/.pi/agent/auth.json`) and comments reference
 * `.pi/skills/...` — only real path segments are violations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../lib/validate-extension.ts";

const ROOT = join(import.meta.dirname, "..");

/** Files that legitimately touch paths outside the resolvers. */
const ALLOWLIST = new Map<string, string>([
  [join("lib", "paths.ts"), "defines the resolvers; reads homedir() for the cache-root fallback"],
  [
    join("extensions", "tool-style", "src", "surface.ts"),
    "reads pywal's palette at ~/.cache/wal, which this repo does not own",
  ],
]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, found);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_template.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Cheap pre-filter: only a file that mentions a risky token can violate, so
 * the TypeScript compiler server parses a handful of files instead of all
 * ~185. Comments make this over-inclusive, which is fine — the AST decides.
 */
const RISKY_TOKEN = /\bhomedir\b|["'`]\.pi[/"'`]/;

function needsAstCheck(file: string): boolean {
  return RISKY_TOKEN.test(readFileSync(file, "utf8"));
}

function conventionsViolations(file: string): string[] {
  const sourceFile = parseSourceFile(file);
  if (!sourceFile) throw new Error(`Failed to parse ${file}`);

  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "homedir") {
      found.add("uses homedir(); global paths go through lib/paths.ts");
    }
    if (ts.isStringLiteral(node) && (node.text === ".pi" || node.text.startsWith(".pi/"))) {
      found.add('hardcodes a ".pi" path segment; use CONFIG_DIR_NAME or lib/paths.ts');
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return [...found];
}

describe("path conventions", () => {
  const files = [...sourceFiles(join(ROOT, "extensions")), ...sourceFiles(join(ROOT, "lib"))];

  it("scans every extension and lib source file", () => {
    // Guards against a broken walk silently passing the suite.
    expect(files.length).toBeGreaterThan(150);
  });

  // The larger cap accommodates slow filesystem metadata walks without
  // masking path violations. A real violation still fails on assertion.
  it("resolves global and project paths through lib/paths.ts", () => {
    const offenders = files
      .filter((file) => !ALLOWLIST.has(relative(ROOT, file)) && needsAstCheck(file))
      .flatMap((file) =>
        conventionsViolations(file).map((message) => `${relative(ROOT, file)}: ${message}`),
      );
    expect(offenders).toEqual([]);
  }, 60_000);

  it("pre-filters before paying for a parse", () => {
    // If this ever reaches the full file count the pre-filter has stopped
    // working and every run pays ~1s of compiler time for nothing.
    expect(files.filter(needsAstCheck).length).toBeLessThan(20);
  });

  it("keeps the allowlist honest", () => {
    for (const path of ALLOWLIST.keys()) {
      expect(existsSync(join(ROOT, path)), `${path} is allowlisted but does not exist`).toBe(true);
    }
  });
});
