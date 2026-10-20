import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionIdentity } from "../../extensions/messenger/src/session-identity.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

describe("session-identity", () => {
  let mockPi: DeepMocked<ExtensionAPI>;
  let mockCtx: DeepMocked<ExtensionContext>;
  const oldEnv: Record<string, string | undefined> = {};

  const identityOptions = {
    customType: "test-identity",
    envVar: "PI_TEST_IDENTITY",
    generate: () => "generated-agent",
  };

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in oldEnv)) oldEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    mockPi = createMockPi() as DeepMocked<ExtensionAPI>;
    mockCtx = createMockContext();
    setEnv("PI_TEST_IDENTITY", undefined);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers the environment override over the persisted identity", async () => {
    setEnv("PI_TEST_IDENTITY", "env-agent");
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "test-identity", data: { name: "persisted-agent" } },
    ]);

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("env-agent");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("reuses the name persisted in the session branch", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "test-identity", data: { name: "persisted-agent" } },
    ]);

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("persisted-agent");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("scans newest-first when multiple identity entries exist", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "test-identity", data: { name: "older-agent" } },
      { type: "custom", customType: "test-identity", data: { name: "newer-agent" } },
    ]);

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("newer-agent");
  });

  it("ignores entries from other extensions and malformed entries", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([
      { type: "custom", customType: "goal-state", data: { goal: {} } },
      { type: "custom", customType: "test-identity", data: {} },
    ]);

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("generated-agent");
    expect(mockPi.appendEntry).toHaveBeenCalledWith("test-identity", { name: "generated-agent" });
  });

  it("generates and persists a name when nothing exists", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue([]);

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("generated-agent");
    expect(mockPi.appendEntry).toHaveBeenCalledWith("test-identity", { name: "generated-agent" });
  });
});
