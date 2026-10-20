import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionIdentity } from "../../extensions/messenger/src/session-identity.ts";
import { createMockContext, type MockContext } from "../mocks/context-mocks.ts";
import { createMockPi, type MockPi } from "../mocks/pi-mocks.ts";
import { sessionEntries } from "../mocks/test-helpers.ts";

describe("session-identity", () => {
  let mockPi: MockPi;
  let mockCtx: MockContext;
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
    mockPi = createMockPi() as MockPi;
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
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue(
      sessionEntries([
        { type: "custom", customType: "test-identity", data: { name: "persisted-agent" } },
      ]),
    );

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("env-agent");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("reuses the name persisted in the session branch", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue(
      sessionEntries([
        { type: "custom", customType: "test-identity", data: { name: "persisted-agent" } },
      ]),
    );

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("persisted-agent");
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });

  it("scans newest-first when multiple identity entries exist", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue(
      sessionEntries([
        { type: "custom", customType: "test-identity", data: { name: "older-agent" } },
        { type: "custom", customType: "test-identity", data: { name: "newer-agent" } },
      ]),
    );

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("newer-agent");
  });

  it("ignores entries from other extensions and malformed entries", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue(
      sessionEntries([
        { type: "custom", customType: "goal-state", data: { goal: {} } },
        { type: "custom", customType: "test-identity", data: {} },
      ]),
    );

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("generated-agent");
    expect(mockPi.appendEntry).toHaveBeenCalledWith("test-identity", { name: "generated-agent" });
  });

  it("generates and persists a name when nothing exists", async () => {
    vi.mocked(mockCtx.sessionManager.getBranch).mockReturnValue(sessionEntries([]));

    const name = await resolveSessionIdentity(mockPi, mockCtx, identityOptions);

    expect(name).toBe("generated-agent");
    expect(mockPi.appendEntry).toHaveBeenCalledWith("test-identity", { name: "generated-agent" });
  });
});
