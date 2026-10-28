import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionSandboxPolicy,
  loadWorkerSandboxPolicy,
} from "../../extensions/worker-sandbox/src/policy.ts";

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

describe("session sandbox policy", () => {
  it("accepts explicit outside write folders without reading project policy", () => {
    const root = project();
    const outside = project();
    const policy = loadSessionSandboxPolicy(
      root,
      JSON.stringify({
        network: { allowedDomains: ["github.com", "*.github.com"] },
        filesystem: { allowWrite: [outside], denyWrite: ["."] },
        excludedCommands: ["terminal-browser *"],
      }),
    );
    expect(policy.filesystem.allowWrite).toEqual([outside]);
    expect(policy.filesystem.denyWrite).toEqual([root]);
    expect(policy.filesystem.denyRead).toEqual([]);
    expect(policy.excludedCommands).toEqual(["terminal-browser *"]);
  });

  it("rejects malformed, incomplete, and weaker inline policies", () => {
    const root = project();
    expect(() => loadSessionSandboxPolicy(root, "{")).toThrow(/sandbox/i);
    expect(() => loadSessionSandboxPolicy(root, "{}")).toThrow(/allowedDomains/);
    expect(() =>
      loadSessionSandboxPolicy(
        root,
        JSON.stringify({
          network: { allowedDomains: [], allowAllUnixSockets: true },
          filesystem: { allowWrite: [] },
        }),
      ),
    ).toThrow(/Unix sockets/);
    expect(() =>
      loadSessionSandboxPolicy(
        root,
        JSON.stringify({
          network: { allowedDomains: [] },
          filesystem: {},
          excludedCommands: ["*"],
        }),
      ),
    ).toThrow(/excludedCommands/);
  });
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

  it("rejects excluded commands in a project-owned worker policy", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: [] },
      filesystem: {},
      excludedCommands: ["terminal-browser *"],
    });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/must not exclude commands/);
  });

  it("rejects non-object filesystem rules and external unfiltered proxies", () => {
    const root = project();
    expect(() =>
      loadSessionSandboxPolicy(
        root,
        JSON.stringify({ network: { allowedDomains: [] }, filesystem: null }),
      ),
    ).toThrow(/filesystem/);
    expect(() =>
      loadSessionSandboxPolicy(
        root,
        JSON.stringify({ network: { allowedDomains: [], httpProxyPort: 8888 }, filesystem: {} }),
      ),
    ).toThrow(/external proxy/);
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

  it("makes a read-only worker's workspace unwritable regardless of project policy", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: ["example.com"], deniedDomains: [] },
      filesystem: { denyRead: ["~"], allowRead: ["."], allowWrite: ["."], denyWrite: [".env"] },
    });
    const policy = loadWorkerSandboxPolicy(root, true);
    expect(policy.filesystem.allowWrite).toEqual([]);
    expect(policy.filesystem.denyWrite).toContain(root);
  });

  it("keeps literal path entries marked and resolves them against the worker directory", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowRead: [{ path: ".", literal: true }],
        allowWrite: [{ path: "br[1]", literal: true }],
        denyWrite: [],
      },
    });
    const policy = loadWorkerSandboxPolicy(root);
    expect(policy.filesystem.allowRead).toEqual([{ path: root, literal: true }]);
    expect(policy.filesystem.allowWrite).toEqual([{ path: join(root, "br[1]"), literal: true }]);
  });

  it("refuses a literal write rule that escapes the worktree", () => {
    const root = project();
    savePolicy(root, {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowWrite: [{ path: "../parent", literal: true }],
        denyWrite: [],
      },
    });
    expect(() => loadWorkerSandboxPolicy(root)).toThrow(/outside the worktree/);
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
