import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export function findExtensionEntrypoints(extensionsDir: string): string[] {
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const extensionDir = join(extensionsDir, entry.name);
      return readdirSync(extensionDir, { withFileTypes: true })
        .filter(
          (file) =>
            file.isFile() && file.name.endsWith(".ts") && !file.name.endsWith("_template.ts"),
        )
        .map((file) => join(extensionDir, file.name));
    })
    .sort();
}

// TypeScript 7 moved source parsing behind a native compiler server: the
// `typescript` package's default export is now just a version stub, and the
// old `ts.createSourceFile(text)` one-liner is gone. The server is synchronous
// but costly to spawn (~100 ms), so a single instance is reused across files
// for a validation run. The validator is a short-lived CLI; the spawned child
// is reclaimed when the process exits, so an explicit close adds coupling for
// no benefit.
let compiler: API | undefined;
function getCompiler(): API {
  compiler ??= new API();
  return compiler;
}

/** Parse a file into a TypeScript AST via the TS 7 native compiler. */
export function parseSourceFile(filePath: string): ts.SourceFile | undefined {
  try {
    const abs = resolve(filePath);
    const snapshot = getCompiler().updateSnapshot({ openFiles: [abs] });
    const project = snapshot.getDefaultProjectForFile(abs);
    return project?.program?.getSourceFile(abs);
  } catch {
    return undefined;
  }
}

export function validateFile(filePath: string): { passed: boolean; messages: string[] } {
  const messages: string[] = [];
  let passed = true;

  function ok(msg: string) {
    messages.push(`  ✅ ${msg}`);
  }

  function error(msg: string) {
    messages.push(`  ❌ ${msg}`);
    passed = false;
  }

  if (!existsSync(filePath)) {
    return { passed: false, messages: [`File not found: ${filePath}`] };
  }

  const sourceFile = parseSourceFile(filePath);
  if (!sourceFile) {
    return { passed: false, messages: [`Failed to parse: ${filePath}`] };
  }

  let hasDefaultExport = false;
  let defaultExportIsAsyncFunction = false;
  const disallowedImports: string[] = [];
  let hasPiApi = false;

  const visit = (node: ts.Node): void => {
    // Export default function declaration (e.g. export default async function foo() {})
    if (ts.isFunctionDeclaration(node) && node.modifiers) {
      const hasExport = node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      const hasAsync = node.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (hasExport && hasDefault) {
        hasDefaultExport = true;
        if (hasAsync) {
          defaultExportIsAsyncFunction = true;
        }
      }
    }

    // Export assignment (e.g. export default async function() {} or export default async (pi) => {})
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true;
      if (ts.isFunctionExpression(node.expression) || ts.isArrowFunction(node.expression)) {
        if (node.expression.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
          defaultExportIsAsyncFunction = true;
        }
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        sourceFile.forEachChild(function findDecl(n: ts.Node) {
          if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
            if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
              defaultExportIsAsyncFunction = true;
            }
          }
          if (ts.isVariableStatement(n)) {
            for (const decl of n.declarationList.declarations) {
              if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
                if (
                  (ts.isFunctionExpression(decl.initializer) ||
                    ts.isArrowFunction(decl.initializer)) &&
                  decl.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
                ) {
                  defaultExportIsAsyncFunction = true;
                }
              }
            }
          }
          n.forEachChild(findDecl);
        });
      }
    }

    // Allowed Pi runtime modules (bundled with the Pi agent, not external npm deps)
    const ALLOWED_RUNTIME_MODULES = [
      "pi",
      "typebox",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-ai/compat",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
      "@earendil-works/pi-coding-agent",
      "@anthropic-ai/sandbox-runtime",
    ];

    function isNodeBuiltin(mod: string): boolean {
      if (mod.startsWith("node:")) return true;
      const bare = mod.split("/")[0] ?? mod;
      const builtins = [
        "assert",
        "async_hooks",
        "buffer",
        "child_process",
        "cluster",
        "console",
        "constants",
        "crypto",
        "dgram",
        "diagnostics_channel",
        "dns",
        "domain",
        "events",
        "fs",
        "http",
        "http2",
        "https",
        "inspector",
        "module",
        "net",
        "os",
        "path",
        "perf_hooks",
        "process",
        "punycode",
        "querystring",
        "readline",
        "repl",
        "stream",
        "string_decoder",
        "sys",
        "timers",
        "tls",
        "trace_events",
        "tty",
        "url",
        "util",
        "v8",
        "vm",
        "wasi",
        "worker_threads",
        "zlib",
      ];
      return builtins.includes(bare);
    }

    // Static imports
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const mod = specifier.text;
        if (!mod.startsWith(".") && !ALLOWED_RUNTIME_MODULES.includes(mod) && !isNodeBuiltin(mod)) {
          disallowedImports.push(mod);
        }
      }
    }

    // Dynamic imports
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const mod = arg.text;
          if (
            !mod.startsWith(".") &&
            !ALLOWED_RUNTIME_MODULES.includes(mod) &&
            !isNodeBuiltin(mod)
          ) {
            disallowedImports.push(mod);
          }
        }
      }
    }

    // Pi API usage
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "pi" &&
        ts.isIdentifier(node.name)
      ) {
        const apiName = node.name.text;
        if (
          [
            "registerTool",
            "registerCommand",
            "on",
            "appendEntry",
            "registerProvider",
            "unregisterProvider",
          ].includes(apiName)
        ) {
          hasPiApi = true;
        }
      }
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);

  if (hasDefaultExport) {
    ok("Has a default export");
  } else {
    error("Missing default export. Extensions must export a default async function.");
  }

  if (defaultExportIsAsyncFunction) {
    ok("Default export is an async function");
  } else {
    error("Default export should be an async function");
  }

  if (disallowedImports.length === 0) {
    ok("No undeclared npm imports (relative imports only)");
  } else {
    error(
      `Undeclared imports detected: ${disallowedImports.join(", ")}. If you need external dependencies, add them to extensions/package.json and document why.`,
    );
  }

  if (hasPiApi) {
    ok("Uses pi API (registerTool, registerCommand, on, appendEntry, or registerProvider)");
  } else {
    error("Extension does not appear to use any pi APIs. It won't do anything.");
  }

  return { passed, messages };
}
