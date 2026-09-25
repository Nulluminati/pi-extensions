/**
 * Tests for the provision config core: loading, merge precedence, strict
 * validation, detect applicability, fingerprint staleness, and git-exclusion
 * hygiene. Uses real temp directories because every function is filesystem
 * I/O; lib/git is mocked so exclusion assertions work without a git binary.
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configApplies,
  ensureProvisionExclusions,
  isProvisionStale,
  loadProvisionConfig,
  recordProvisionInputs,
  validateProvisionConfig,
} from "../../extensions/agents/src/provision/config.ts";
import {
  PROVISION_CONFIG_FILE,
  PROVISION_LOCAL_FILE,
  PROVISION_STATE_FILE,
  provisionConfigPath,
  provisionLocalPath,
  provisionStatePath,
} from "../../extensions/agents/src/provision/types.ts";
import { excludeFromGit } from "../../lib/git.ts";
import { projectStateRelative } from "../../lib/paths.ts";

vi.mock("../../lib/git.ts", () => ({ excludeFromGit: vi.fn(async () => true) }));

describe("provision-config", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "provision-config-"));
    vi.mocked(excludeFromGit).mockClear();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  describe("loadProvisionConfig", () => {
    it("returns null when neither config file exists", async () => {
      expect(await loadProvisionConfig(cwd)).toBeNull();
    });

    it("loads a committed config alone", async () => {
      await writeJson(provisionConfigPath(cwd), { share: "install" });
      const loaded = await loadProvisionConfig(cwd);
      expect(loaded).toEqual({
        config: { share: "install" },
        hasCommitted: true,
        hasLocal: false,
      });
    });

    it("loads a local config alone", async () => {
      await writeJson(provisionLocalPath(cwd), { carryUnsafe: true });
      const loaded = await loadProvisionConfig(cwd);
      expect(loaded).toEqual({
        config: { carryUnsafe: true },
        hasCommitted: false,
        hasLocal: true,
      });
    });

    it("merges local over committed field by field", async () => {
      await writeJson(provisionConfigPath(cwd), {
        carry: [".env"],
        detect: { any: ["package-lock.json"] },
        share: "hardlink-copy",
        timeoutSeconds: 60,
      });
      await writeJson(provisionLocalPath(cwd), {
        carry: [".env", ".env.local"],
        carryUnsafe: true,
        detect: { any: ["pnpm-lock.yaml"] },
        timeoutSeconds: 90,
      });
      const loaded = await loadProvisionConfig(cwd);
      expect(loaded).toEqual({
        config: {
          carry: [".env", ".env.local"],
          carryUnsafe: true,
          detect: { any: ["pnpm-lock.yaml"] },
          share: "hardlink-copy",
          timeoutSeconds: 90,
        },
        hasCommitted: true,
        hasLocal: true,
      });
    });

    it("throws descriptively when an existing config is not valid JSON", async () => {
      const path = provisionConfigPath(cwd);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "{ not json", "utf8");
      await expect(loadProvisionConfig(cwd)).rejects.toThrow(path);
    });

    it("throws when an existing config file is not a JSON object", async () => {
      await writeJson(provisionConfigPath(cwd), ["package-lock.json"]);
      await expect(loadProvisionConfig(cwd)).rejects.toThrow("JSON object");
    });
  });

  describe("validateProvisionConfig", () => {
    it("accepts a fully populated config with no issues", () => {
      const issues = validateProvisionConfig(
        {
          carry: [".env"],
          detect: { any: ["package-lock.json"] },
          network: ["registry.npmjs.org"],
          provision: "npm ci",
          providesOwn: true,
          share: "hardlink-copy",
          timeoutSeconds: 300,
        },
        PROVISION_CONFIG_FILE,
      );
      expect(issues).toEqual([]);
    });

    it("accepts carryUnsafe in the local config", () => {
      const issues = validateProvisionConfig({ carryUnsafe: true }, PROVISION_LOCAL_FILE);
      expect(issues).toEqual([]);
    });

    it("rejects carryUnsafe in the committed config as local-only", () => {
      const issues = validateProvisionConfig({ carryUnsafe: true }, PROVISION_CONFIG_FILE);
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe("carryUnsafe");
      expect(issues[0].file).toBe(PROVISION_CONFIG_FILE);
      expect(issues[0].message).toContain(PROVISION_LOCAL_FILE);
    });

    it("flags unknown top-level keys to catch typos", () => {
      const issues = validateProvisionConfig(
        { share: "none", shar: "hardlink-copy" },
        PROVISION_CONFIG_FILE,
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe("shar");
      expect(issues[0].message).toContain("unknown field");
    });

    it("rejects a share strategy outside SHARE_STRATEGIES", () => {
      const issues = validateProvisionConfig({ share: "symlink" }, PROVISION_CONFIG_FILE);
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe("share");
    });

    it("rejects a timeoutSeconds that is not a positive finite number", () => {
      for (const timeoutSeconds of [0, -5, "120", true]) {
        const issues = validateProvisionConfig({ timeoutSeconds }, PROVISION_CONFIG_FILE);
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toBe("timeoutSeconds");
      }
    });

    it("accepts a fractional timeoutSeconds", () => {
      const issues = validateProvisionConfig({ timeoutSeconds: 2.5 }, PROVISION_CONFIG_FILE);
      expect(issues).toEqual([]);
    });

    it("rejects detect that is not an object", () => {
      const issues = validateProvisionConfig(
        { detect: "package-lock.json" },
        PROVISION_CONFIG_FILE,
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe("detect");
    });

    it("rejects detect.any that is not an array of non-empty strings", () => {
      for (const any of ["package-lock.json", [""], ["ok", 5], {}]) {
        const issues = validateProvisionConfig({ detect: { any } }, PROVISION_CONFIG_FILE);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0].path).toContain("detect.any");
      }
    });

    it("type-checks every other present field", () => {
      const issues = validateProvisionConfig(
        {
          carry: ".env",
          network: [42],
          provision: 7,
          providesOwn: "yes",
        },
        PROVISION_CONFIG_FILE,
      );
      const paths = issues.map((issue) => issue.path).sort();
      expect(paths).toEqual(["carry", "network[0]", "providesOwn", "provision"]);
    });

    it("rejects a config that is not a JSON object", () => {
      for (const raw of [null, "config", [], 42]) {
        const issues = validateProvisionConfig(raw, PROVISION_CONFIG_FILE);
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toBe("");
      }
    });
  });

  describe("configApplies", () => {
    it("applies when there is no config at all", async () => {
      expect(await configApplies(cwd)).toBe(true);
    });

    it("applies when the config has no detect section", async () => {
      await writeJson(provisionConfigPath(cwd), { share: "none" });
      expect(await configApplies(cwd)).toBe(true);
    });

    it("applies when at least one detect.any path exists", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["missing.lock", "present.txt"] },
      });
      await writeFile(join(cwd, "present.txt"), "x", "utf8");
      expect(await configApplies(cwd)).toBe(true);
    });

    it("does not apply when no detect.any path exists", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["missing.lock", "also-missing.lock"] },
      });
      expect(await configApplies(cwd)).toBe(false);
    });

    it("does not apply when detect.any is empty", async () => {
      await writeJson(provisionConfigPath(cwd), { detect: { any: [] } });
      expect(await configApplies(cwd)).toBe(false);
    });
  });

  describe("isProvisionStale", () => {
    it("is stale with no fingerprint recorded", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      expect(await isProvisionStale(cwd)).toEqual({
        stale: true,
        reasons: ["no provision fingerprint recorded"],
      });
    });

    it("is fresh after recordProvisionInputs stamps the detect inputs", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);
      expect(await isProvisionStale(cwd)).toEqual({ stale: false, reasons: [] });
    });

    it("is stale naming the file when a detect input changes", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);
      await writeFile(join(cwd, "package.json"), '{"name":"x"}', "utf8");

      const { stale, reasons } = await isProvisionStale(cwd);
      expect(stale).toBe(true);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("package.json");
    });

    it("is stale naming the file when a detect input is deleted", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);
      await rm(join(cwd, "package.json"));

      const { stale, reasons } = await isProvisionStale(cwd);
      expect(stale).toBe(true);
      expect(reasons[0]).toContain("package.json");
    });

    it("is stale naming the file when an input is added to detect", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await writeFile(join(cwd, "tsconfig.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);

      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json", "tsconfig.json"] },
      });
      const { stale, reasons } = await isProvisionStale(cwd);
      expect(stale).toBe(true);
      expect(reasons[0]).toContain("tsconfig.json");
    });

    it("stays fresh while a detect input stays absent", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["pnpm-lock.yaml"] },
      });
      await recordProvisionInputs(cwd);
      expect(await isProvisionStale(cwd)).toEqual({ stale: false, reasons: [] });
    });

    it("is stale when an absent detect input appears", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["pnpm-lock.yaml"] },
      });
      await recordProvisionInputs(cwd);
      await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfile", "utf8");

      const { stale, reasons } = await isProvisionStale(cwd);
      expect(stale).toBe(true);
      expect(reasons[0]).toContain("pnpm-lock.yaml");
    });

    it("stores sha256 hex digests and a timestamp in the state file", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);

      const state = JSON.parse(await readFile(provisionStatePath(cwd), "utf8"));
      expect(state.inputs["package.json"]).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof state.at).toBe("number");
    });
  });

  describe("recordProvisionInputs", () => {
    it("skips the state write when the fingerprint is unchanged", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);

      const path = provisionStatePath(cwd);
      const stale = new Date("2020-01-01T00:00:00Z");
      await utimes(path, stale, stale);

      await recordProvisionInputs(cwd);
      const after = await stat(path);
      expect(after.mtimeMs).toBe(stale.getTime());
    });

    it("rewrites the state file when a detect input changed", async () => {
      await writeJson(provisionConfigPath(cwd), {
        detect: { any: ["package.json"] },
      });
      await writeFile(join(cwd, "package.json"), "{}", "utf8");
      await recordProvisionInputs(cwd);
      await writeFile(join(cwd, "package.json"), '{"name":"x"}', "utf8");

      const path = provisionStatePath(cwd);
      const before = await stat(path);
      await recordProvisionInputs(cwd);
      const after = await stat(path);
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);

      // The fresh stamp clears staleness.
      expect(await isProvisionStale(cwd)).toEqual({ stale: false, reasons: [] });
    });
  });

  describe("ensureProvisionExclusions", () => {
    it("excludes state, local config, and the skill directory from git", async () => {
      await ensureProvisionExclusions(cwd);

      expect(excludeFromGit).toHaveBeenCalledTimes(3);
      expect(excludeFromGit).toHaveBeenCalledWith(cwd, projectStateRelative(PROVISION_STATE_FILE));
      expect(excludeFromGit).toHaveBeenCalledWith(cwd, projectStateRelative(PROVISION_LOCAL_FILE));
      expect(excludeFromGit).toHaveBeenCalledWith(
        cwd,
        projectStateRelative(join("skills", "provision")),
      );
    });
  });
});

// --- Helpers ---

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
