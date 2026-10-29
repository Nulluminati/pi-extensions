/**
 * Filesystem-convention enforcement.
 *
 * Extension state resolves through lib/paths.ts so PI_CODING_AGENT_DIR,
 * XDG_CACHE_HOME, and a rebranded CONFIG_DIR_NAME are honored. The entrypoint
 * validator never parses src/ modules, so this walks every source file's AST
 * in extensions/, lib/, and scripts/. Only lib/paths.ts may read homedir() or
 * CONFIG_DIR_NAME directly; everything else calls its resolvers.
 * An AST scan rather than a text grep because user-facing strings legitimately
 * mention Pi's own paths (`~/.pi/agent/auth.json`) and comments reference
 * `.pi/skills/...` — only real path segments are violations.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as ts from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../lib/validate-extension.ts";

const ROOT = join(import.meta.dirname, "..");

/** Files that legitimately touch paths outside the resolvers. */
const ALLOWLIST = new Map<string, string>([
  [join("lib", "paths.ts"), "defines the resolvers; reads homedir() for the cache-root fallback"],
  [
    join("extensions", "codex-image", "src", "auth.ts"),
    "reads Codex CLI credentials from its own home, separate from Pi's agent directory",
  ],
  [
    join("extensions", "codex-image", "src", "config.ts"),
    "reads Codex CLI model config from its own home, separate from Pi's agent directory",
  ],
  [
    join("extensions", "tool-style", "src", "surface.ts"),
    "reads pywal's palette at ~/.cache/wal, which this repo does not own",
  ],
  [
    join("scripts", "codemode-evaluation", "runtime.ts"),
    "expands ~/ in package sources read from the user's settings.json",
  ],
  [
    join("scripts", "virtual-models-eval", "tasks.ts"),
    "writes eval fixtures at the fixed .pi/ paths its scored prompts name verbatim",
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
      (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) &&
      !entry.name.endsWith("_template.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Cheap pre-filter: only a file that mentions a risky token can violate, so
 * the TypeScript compiler server parses a handful of source files. Comments
 * make this over-inclusive, which is fine — the AST decides.
 */
const RISKY_TOKEN = /\bhomedir\b|\bCONFIG_DIR_NAME\b|["'`]\.pi[/"'`]/;

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
    if (ts.isIdentifier(node) && node.text === "CONFIG_DIR_NAME") {
      found.add("uses CONFIG_DIR_NAME directly; use lib/paths.ts");
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
  const files = [
    ...sourceFiles(join(ROOT, "extensions")),
    ...sourceFiles(join(ROOT, "lib")),
    ...sourceFiles(join(ROOT, "scripts")),
  ];

  it("scans every extension, lib, and script source file", () => {
    // Guards against a broken walk silently passing the suite.
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain(join(ROOT, "extensions", "worker-sandbox", "src", "broker.mjs"));
    expect(files).toContain(join(ROOT, "extensions", "worker-sandbox", "src", "tool-child.mjs"));
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

  it("parses a JavaScript source violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-conventions-"));
    try {
      const file = join(dir, "unsafe.mjs");
      writeFileSync(file, 'import { homedir } from "node:os"; export const state = homedir();\n');
      expect(conventionsViolations(file)).toContain(
        "uses homedir(); global paths go through lib/paths.ts",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags direct CONFIG_DIR_NAME use", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-conventions-"));
    try {
      const file = join(dir, "unsafe.ts");
      writeFileSync(
        file,
        'import { join } from "node:path";\nimport { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";\nexport const state = join(process.cwd(), CONFIG_DIR_NAME, "x");\n',
      );
      expect(conventionsViolations(file)).toContain(
        "uses CONFIG_DIR_NAME directly; use lib/paths.ts",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
