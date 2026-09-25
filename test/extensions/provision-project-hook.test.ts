import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("project worktree setup", () => {
  it("routes the optional NuGet install through the sandbox HTTP proxy", () => {
    const worktree = mkdtempSync(join(tmpdir(), "provision-project-hook-"));
    try {
      mkdirSync(join(worktree, "scripts"));
      mkdirSync(join(worktree, "bin"));
      copyFileSync(
        join(root, "scripts/provision-worktree"),
        join(worktree, "scripts/provision-worktree"),
      );
      const npm = join(worktree, "bin/npm");
      writeFileSync(
        npm,
        "#!/bin/sh\nprintf '%s\\n' \"$HTTPS_PROXY\" > proxy.txt\nprintf '%s\\n' \"$NODE_OPTIONS\" > node-options.txt\nprintf '%s\\n' \"$*\" > args.txt\n",
      );
      chmodSync(npm, 0o755);
      const result = spawnSync("./scripts/provision-worktree", [], {
        cwd: worktree,
        env: {
          PATH: `${join(worktree, "bin")}:/usr/bin:/bin`,
          HTTPS_PROXY: "http://sandbox-proxy:3128",
          NODE_OPTIONS: "--max-old-space-size=1024",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(readFileSync(join(worktree, "proxy.txt"), "utf8")).toBe("http://sandbox-proxy:3128\n");
      expect(readFileSync(join(worktree, "node-options.txt"), "utf8")).toBe(
        "--max-old-space-size=1024 --use-env-proxy\n",
      );
      expect(readFileSync(join(worktree, "args.txt"), "utf8")).toBe(
        "install --no-audit --no-fund\n",
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("permits NuGet through the project sandbox policy", () => {
    const policy = JSON.parse(readFileSync(join(root, ".pi/sandbox.json"), "utf8"));
    expect(policy.network.allowedDomains).toContain("api.nuget.org");
  });
});
