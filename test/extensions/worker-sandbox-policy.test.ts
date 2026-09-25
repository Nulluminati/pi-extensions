import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkerSandboxPolicy } from "../../extensions/worker-sandbox/src/policy.ts";

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "worker-sandbox-policy-"));
  roots.push(root);
  return root;
}

function savePolicy(root: string, policy: unknown): void {
  const directory = join(root, CONFIG_DIR_NAME);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "sandbox.json"), JSON.stringify(policy));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker sandbox policy", () => {
  it("refuses a missing policy instead of starting with permissive defaults", () => {
    const root = project();
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/sandbox\.json/);
  });

  it("requires explicit network and filesystem policy", () => {
    const root = project();
    savePolicy(root, { filesystem: { allowWrite: ["."], denyRead: ["~"] } });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/allowedDomains/);
    savePolicy(root, { network: { allowedDomains: [] } });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/filesystem/);
  });

  it("validates the policy with the sandbox runtime schema", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: "example.com" },
      filesystem: { denyRead: ["~"], allowWrite: ["."] },
    });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/allowedDomains/);
  });

  it("resolves project paths against the worker directory and preserves home paths", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: ["example.com"], deniedDomains: [] },
      filesystem: {
        denyRead: ["~", "/tmp", "secrets/**"],
        allowRead: ["."],
        allowWrite: ["."],
        denyWrite: [".env"],
      },
    });
    const policy = loadWorkerSandboxPolicy(root);
    expect(policy.network.allowedDomains).toEqual(["example.com"]);
    expect(policy.filesystem.denyRead).toEqual(["~", "/tmp", join(root, "secrets/**")]);
    expect(policy.filesystem.allowRead).toEqual([root]);
    expect(policy.filesystem.allowWrite).toEqual([root]);
    expect(policy.filesystem.denyWrite).toEqual([join(root, ".env")]);
  });

  it("refuses relative write rules that escape the worktree", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ["../parent"], denyWrite: [] },
    });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/outside the worktree/);
  });

  it("refuses writable symlinks that lead outside the worktree", () => {
    const root = project();
    const outside = project();
    symlinkSync(outside, join(root, "link"));
    savePolicy(root, {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ["link"], denyWrite: [] },
    });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/outside the worktree/);
  });

  it("refuses settings that disable isolation or expose host sockets", () => {
    const root = project();
    const base = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] },
    };
    savePolicy(root, { ...base, network: { ...base.network, allowAllUnixSockets: true } });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/Unix sockets/);
    savePolicy(root, { ...base, network: { ...base.network, allowLocalBinding: true } });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/local binding/);
    savePolicy(root, { ...base, filesystem: { ...base.filesystem, disabled: true } });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/filesystem isolation/);
  });
});
