import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_EXTENSIONS,
  FORBIDDEN_WORKER_EXTENSIONS,
  resolveWorkerExtensions,
  WORKER_EXTENSIONS_ENV_VAR,
} from "../../lib/worker-extensions.ts";

describe("worker-extensions", () => {
  let root: string;
  let configPath: string;
  const oldEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-extensions-"));
    configPath = join(root, "worker-extensions.json");
    // Fake extension directories: <root>/<name>/<name>.ts
    for (const name of DEFAULT_WORKER_EXTENSIONS) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, `${name}.ts`), "export default async () => {};");
    }
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "agents.ts"), "export default async () => {};");
    setEnv(WORKER_EXTENSIONS_ENV_VAR, undefined);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to the default set plus mandatory extensions, resolved to paths", () => {
    const resolved = resolveWorkerExtensions(undefined, {
      extensionsRoot: root,
      configPath,
    });

    const names = resolved.map((r) => r.name);
    expect(names[0]).toBe("messenger");
    expect(names.at(-1)).toBe("gondolin");
    for (const name of DEFAULT_WORKER_EXTENSIONS) expect(names).toContain(name);
    for (const r of resolved) expect(existsSync(r.path)).toBe(true);
  });

  it("explicit parameter wins over environment and config", () => {
    setEnv(WORKER_EXTENSIONS_ENV_VAR, "messenger,web-search");
    writeFileSync(configPath, JSON.stringify(["messenger", "code-search"]));

    const resolved = resolveWorkerExtensions(["messenger", "context7"], {
      extensionsRoot: root,
      configPath,
    });

    expect(resolved.map((r) => r.name)).toEqual(["messenger", "context7", "gondolin"]);
  });

  it("parses the environment list (comma-separated, trimmed)", () => {
    setEnv(WORKER_EXTENSIONS_ENV_VAR, " messenger , web-search ");

    const resolved = resolveWorkerExtensions(undefined, {
      extensionsRoot: root,
      configPath,
    });

    expect(resolved.map((r) => r.name)).toEqual(["messenger", "web-search", "gondolin"]);
  });

  it("loads the config file when no env or explicit set", () => {
    writeFileSync(configPath, JSON.stringify(["messenger", "web-search"]));

    const resolved = resolveWorkerExtensions(undefined, {
      extensionsRoot: root,
      configPath,
    });

    expect(resolved.map((r) => r.name)).toEqual(["messenger", "web-search", "gondolin"]);
  });

  it("force-includes messenger and gondolin even when the explicit list is empty", () => {
    const resolved = resolveWorkerExtensions([], {
      extensionsRoot: root,
      configPath,
    });

    expect(resolved.map((r) => r.name)).toEqual(["messenger", "gondolin"]);
  });

  it("dedupes mandatory and requested extensions", () => {
    const resolved = resolveWorkerExtensions(
      ["messenger", "gondolin", "web-search", "web-search"],
      {
        extensionsRoot: root,
        configPath,
      },
    );

    const names = resolved.map((r) => r.name);
    expect(names.filter((n) => n === "messenger")).toHaveLength(1);
    expect(names.filter((n) => n === "gondolin")).toHaveLength(1);
    expect(names.filter((n) => n === "web-search")).toHaveLength(1);
  });

  it("hard-rejects denylisted extensions even when explicitly requested", () => {
    for (const forbidden of FORBIDDEN_WORKER_EXTENSIONS) {
      expect(() =>
        resolveWorkerExtensions(["messenger", forbidden], {
          extensionsRoot: root,
          configPath,
        }),
      ).toThrow(new RegExp(forbidden));
    }
  });

  it("rejects unknown extension names", () => {
    expect(() =>
      resolveWorkerExtensions(["messenger", "does-not-exist"], {
        extensionsRoot: root,
        configPath,
      }),
    ).toThrow(/does-not-exist/);
  });

  it("rejects path traversal names that would resolve a denylisted extension", () => {
    // "agents/../agents" resolves to extensions/agents/agents.ts, defeating
    // the literal-name denylist check.
    expect(() =>
      resolveWorkerExtensions(["agents/../agents"], {
        extensionsRoot: root,
        configPath,
      }),
    ).toThrow(/Invalid worker extension name/);
    expect(() =>
      resolveWorkerExtensions(["messenger", "../agents"], {
        extensionsRoot: root,
        configPath,
      }),
    ).toThrow(/Invalid worker extension name/);
  });

  it("rejects names outside the lowercase letters, digits, and hyphens convention", () => {
    for (const bad of ["foo/bar", "..", ".", "Agents", "a b", "web_search", ""]) {
      expect(() => resolveWorkerExtensions([bad], { extensionsRoot: root, configPath })).toThrow(
        /Invalid worker extension name/,
      );
    }
    // Well-formed names still resolve to paths.
    const resolved = resolveWorkerExtensions(["web-search"], {
      extensionsRoot: root,
      configPath,
    });
    expect(resolved.map((r) => r.name)).toEqual(["messenger", "web-search", "gondolin"]);
  });

  it("rejects malformed config files and env values with descriptive errors", () => {
    writeFileSync(configPath, "{ not json");
    expect(() => resolveWorkerExtensions(undefined, { extensionsRoot: root, configPath })).toThrow(
      /worker extensions config/i,
    );

    setEnv(WORKER_EXTENSIONS_ENV_VAR, ",,messenger");
    expect(() => resolveWorkerExtensions(undefined, { extensionsRoot: root, configPath })).toThrow(
      /PI_WORKER_EXTENSIONS/,
    );
  });
});
