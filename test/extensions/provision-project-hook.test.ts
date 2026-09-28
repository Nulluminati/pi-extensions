import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("project worktree setup", () => {
  it("passes proxy and Node options to the package installer for native postinstall downloads", () => {
    const worktree = mkdtempSync(join(tmpdir(), "provision-project-hook-"));
    try {
      mkdirSync(join(worktree, ".pi"));
      mkdirSync(join(worktree, "bin"));
      copyFileSync(join(root, ".pi/provision-worktree"), join(worktree, ".pi/provision-worktree"));
      const npm = join(worktree, "bin/npm");
      writeFileSync(
        npm,
        "#!/bin/sh\nprintf '%s\\n' \"$HTTPS_PROXY\" > proxy.txt\nprintf '%s\\n' \"$NODE_OPTIONS\" > node-options.txt\nprintf '%s\\n' \"$*\" > args.txt\nprintf '%s\\n' \"$TMPDIR\" > tmpdir.txt\nprintf '%s\\n' \"$npm_config_cache\" > cache.txt\nprintf '%s\\n' \"$HUSKY\" > husky.txt\n",
      );
      chmodSync(npm, 0o755);
      const result = spawnSync("./.pi/provision-worktree", [], {
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
      const temporary = readFileSync(join(worktree, "tmpdir.txt"), "utf8").trim();
      const cache = readFileSync(join(worktree, "cache.txt"), "utf8").trim();
      expect(temporary).toMatch(new RegExp(`^${worktree}/\\.pi/provision-tmp-`));
      expect(cache).toBe(join(temporary, "npm-cache"));
      expect(readFileSync(join(worktree, "husky.txt"), "utf8")).toBe("0\n");
      expect(existsSync(temporary)).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("removes package cache and temporary files when installation fails", () => {
    const worktree = mkdtempSync(join(tmpdir(), "provision-project-hook-"));
    try {
      mkdirSync(join(worktree, ".pi"));
      mkdirSync(join(worktree, "bin"));
      copyFileSync(join(root, ".pi/provision-worktree"), join(worktree, ".pi/provision-worktree"));
      const npm = join(worktree, "bin/npm");
      writeFileSync(
        npm,
        '#!/bin/sh\nmkdir -p "$npm_config_cache"\nprintf \'cache\' > "$npm_config_cache/item"\nexit 9\n',
      );
      chmodSync(npm, 0o755);
      const result = spawnSync("./.pi/provision-worktree", [], {
        cwd: worktree,
        env: { PATH: `${join(worktree, "bin")}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(result.status).toBe(9);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      // Scratch is swept; the tracked hook itself survives.
      expect(readdirSync(join(worktree, ".pi"))).toEqual(["provision-worktree"]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("permits NuGet through the project sandbox policy", () => {
    const policy = JSON.parse(readFileSync(join(root, ".pi/sandbox.json"), "utf8"));
    expect(policy.network.allowedDomains).toContain("api.nuget.org");
  });
});
