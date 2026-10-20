import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findExtensionEntrypoints, validateFile } from "../lib/validate-extension.ts";

const tempFiles: string[] = [];

function withTempFile(content: string, suffix = ".ts"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
  const filePath = join(dir, `test${suffix}`);
  writeFileSync(filePath, content, "utf-8");
  tempFiles.push(filePath);
  return filePath;
}

function cleanup(filePath: string) {
  const dir = filePath.replace(/\/test[^/]*$/, "");
  rmSync(dir, { recursive: true, force: true });
}

afterEach(() => {
  for (const file of tempFiles) {
    try {
      cleanup(file);
    } catch {
      // ignore cleanup errors
    }
  }
  tempFiles.length = 0;
});

describe("findExtensionEntrypoints", () => {
  it("returns root entrypoints without treating src modules as extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ext-tree-test-"));
    const extensionDir = join(dir, "example");
    const sourceDir = join(extensionDir, "src");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(extensionDir, "example.ts"), "export default async function example() {}\n");
    writeFileSync(join(sourceDir, "helper.ts"), "export function helper() {}\n");
    tempFiles.push(join(dir, "test.ts"));

    expect(findExtensionEntrypoints(dir)).toEqual([join(extensionDir, "example.ts")]);
  });
});

describe("validateFile", () => {
  it("passes for a valid extension with command", () => {
    const file = withTempFile(`
export default async function (pi: any) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (_args: any, _ctx: any) => {
      pi.appendEntry({ role: "assistant", content: "Hello" });
    },
  });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("passes for a valid extension with tool", () => {
    const file = withTempFile(`
export default async function (pi: any) {
  pi.registerTool({
    name: "myTool",
    label: "My Tool",
    description: "Does something",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("passes for a valid extension with event hook", () => {
    const file = withTempFile(`
export default async function (pi: any) {
  pi.on("toolCall", async (_event: any, _ctx: any) => {});
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("fails when file is missing", () => {
    const result = validateFile("/nonexistent/file.ts");
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("File not found")]),
    );
  });

  it("fails when there is no default export", () => {
    const file = withTempFile(`
export async function foo(pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("Missing default export")]),
    );
  });

  it("fails when default export is not async", () => {
    const file = withTempFile(`
export default function (pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("async function")]),
    );
  });

  it("fails on undeclared npm imports", () => {
    const file = withTempFile(`
import { foo } from "some-random-package";
export default async function (pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("some-random-package")]),
    );
  });

  it("allows relative imports", () => {
    const file = withTempFile(`
import { helper } from "./helper";
export default async function (pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("rejects the retired pi type module", () => {
    const file = withTempFile(`
import type { ExtensionAPI } from "pi";
export default async function (pi: ExtensionAPI) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("Undeclared imports detected: pi.")]),
    );
  });

  it("fails when no pi API is used", () => {
    const file = withTempFile(`
export default async function (pi: any) {
  console.log("No pi API here");
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(false);
    expect(result.messages).toEqual(
      expect.arrayContaining([expect.stringContaining("won't do anything")]),
    );
  });

  it("passes for arrow-function default export", () => {
    const file = withTempFile(`
export default async (pi: any) => {
  pi.appendEntry({ role: "assistant", content: "Hello" });
};
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("allows Pi runtime module imports", () => {
    const file = withTempFile(`
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
export default async function (pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });

  it("allows Node.js built-in imports", () => {
    const file = withTempFile(`
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default async function (pi: any) {
  pi.registerCommand("hello", { description: "Hi", handler: async () => {} });
}
`);
    const result = validateFile(file);
    expect(result.passed).toBe(true);
  });
});
