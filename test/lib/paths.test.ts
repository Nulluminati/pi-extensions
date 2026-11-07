import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  agentConfigPath,
  agentStateDir,
  authPath,
  cacheDir,
  isProjectStatePath,
  projectConfigPath,
  projectStateDir,
  projectStateRelative,
} from "../../lib/paths.ts";

describe("paths", () => {
  describe("agentConfigPath", () => {
    it("places config at the agent root", () => {
      expect(agentConfigPath("handoff", "/home/test/.pi/agent")).toBe(
        "/home/test/.pi/agent/handoff.json",
      );
    });

    it("defaults to the live agent dir", () => {
      // The setup mock resolves getAgentDir() to /home/test/.pi/agent.
      expect(agentConfigPath("context7")).toBe("/home/test/.pi/agent/context7.json");
    });
  });

  describe("agentStateDir", () => {
    it("names the state directory after the extension", () => {
      expect(agentStateDir("background-jobs", "/home/test/.pi/agent")).toBe(
        "/home/test/.pi/agent/background-jobs",
      );
    });
  });

  describe("authPath", () => {
    it("points at Pi's auth store inside the agent dir", () => {
      expect(authPath("/home/test/.pi/agent")).toBe("/home/test/.pi/agent/auth.json");
    });

    it("follows a relocated agent dir", () => {
      expect(authPath("/relocated/agent")).toBe("/relocated/agent/auth.json");
    });
  });

  describe("cacheDir", () => {
    it("uses XDG_CACHE_HOME when set", () => {
      expect(cacheDir("handoff", { XDG_CACHE_HOME: "/xdg" }, "/home/test")).toBe("/xdg/pi-handoff");
    });

    it("falls back to ~/.cache when unset", () => {
      expect(cacheDir("handoff", {}, "/home/test")).toBe("/home/test/.cache/pi-handoff");
    });

    it("ignores a blank XDG_CACHE_HOME", () => {
      expect(cacheDir("context7", { XDG_CACHE_HOME: "  " }, "/home/test")).toBe(
        "/home/test/.cache/pi-context7",
      );
    });
  });

  describe("projectConfigPath", () => {
    it("places a project config file directly under CONFIG_DIR_NAME", () => {
      expect(projectConfigPath("/repo", "sandbox.json")).toBe(
        join("/repo", CONFIG_DIR_NAME, "sandbox.json"),
      );
    });
  });

  describe("projectStateDir", () => {
    it("namespaces under CONFIG_DIR_NAME", () => {
      expect(projectStateDir("/repo", "missions")).toBe(join("/repo", CONFIG_DIR_NAME, "missions"));
    });
  });

  describe("projectStateRelative", () => {
    it("produces a project-relative path for git excludes", () => {
      expect(projectStateRelative("autoresearch")).toBe(`${CONFIG_DIR_NAME}/autoresearch`);
    });
  });

  describe("isProjectStatePath", () => {
    it("accepts the config dir and anything inside it", () => {
      expect(isProjectStatePath(CONFIG_DIR_NAME)).toBe(true);
      expect(isProjectStatePath(projectStateRelative("messenger"))).toBe(true);
      expect(isProjectStatePath(`${CONFIG_DIR_NAME}/messenger/registry/a.json`)).toBe(true);
    });

    it("rejects sibling paths that merely share a prefix", () => {
      expect(isProjectStatePath(`${CONFIG_DIR_NAME}x/file`)).toBe(false);
      expect(isProjectStatePath("src/index.ts")).toBe(false);
      expect(isProjectStatePath("README.md")).toBe(false);
    });
  });
});
