#!/usr/bin/env tsx
/**
 * Compare our hand-written types/pi.d.ts against Pi's actual runtime types.
 * Run: tsx scripts/sync-pi-types.ts
 */
import { readFileSync } from "node:fs";
import * as ts from "typescript";

const PI_TYPES_PATH =
  "/home/natekift/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts";
const OUR_TYPES_PATH = "./types/pi.d.ts";

interface MemberInfo {
  name: string;
  signature: string;
}

function extractInterfaceMembers(filePath: string, interfaceName: string): MemberInfo[] {
  const source = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const members: MemberInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member) || ts.isPropertySignature(member)) {
          const memberName = member.name;
          if (!memberName) continue;
          const name = memberName.getText(sourceFile);
          const start = member.getStart(sourceFile);
          const end = member.getEnd();
          const signature = source.slice(start, end).split("\n")[0]?.trim() ?? "";
          members.push({ name, signature });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return members;
}

function compareMembers(piMembers: MemberInfo[], ourMembers: MemberInfo[]) {
  const piNames = new Set(piMembers.map((m) => m.name));
  const ourNames = new Set(ourMembers.map((m) => m.name));

  const missing = piMembers.filter((m) => !ourNames.has(m.name));
  const extra = ourMembers.filter((m) => !piNames.has(m.name));
  const shared = piMembers.filter((m) => ourNames.has(m.name));

  return { missing, extra, shared };
}

function printSection(title: string, members: MemberInfo[]) {
  console.log(`\n${title} (${members.length}):`);
  if (members.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const m of members) {
    console.log(`  ${m.signature}`);
  }
}

const interfaces = ["ExtensionAPI", "ExtensionContext", "ExtensionCommandContext"];

for (const iface of interfaces) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Interface: ${iface}`);
  console.log("=".repeat(60));

  const pi = extractInterfaceMembers(PI_TYPES_PATH, iface);
  const ours = extractInterfaceMembers(OUR_TYPES_PATH, iface);
  const { missing, extra, shared } = compareMembers(pi, ours);

  printSection("✅ Shared", shared);
  printSection("❌ Missing from our types", missing);
  printSection("⚠️  Extra in our types", extra);
}

// Also check mock coverage
console.log(`\n${"=".repeat(60)}`);
console.log("Mock Coverage Check: createMockPi()");
console.log("=".repeat(60));

const piApi = extractInterfaceMembers(PI_TYPES_PATH, "ExtensionAPI");
const mockSource = readFileSync("./test/mocks/pi-mocks.ts", "utf-8");
const mockFile = ts.createSourceFile("pi-mocks.ts", mockSource, ts.ScriptTarget.Latest, true);
const mockProps = new Set<string>();

function visitMock(node: ts.Node) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        mockProps.add(prop.name.text);
      }
    }
  }
  ts.forEachChild(node, visitMock);
}
visitMock(mockFile);

const missingMocks = piApi.filter((m) => !mockProps.has(m.name));
if (missingMocks.length) {
  console.log(`\n❌ Missing from createMockPi() (${missingMocks.length}):`);
  for (const m of missingMocks) {
    console.log(`  ${m.signature}`);
  }
} else {
  console.log("\n✅ All ExtensionAPI members are mocked");
}
