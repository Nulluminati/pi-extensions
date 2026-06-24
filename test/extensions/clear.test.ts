import { beforeEach, describe, expect, it, vi } from "vitest";
import clearExtension from "../../extensions/clear/clear.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler } from "../mocks/test-helpers.ts";

describe("clear-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("registers /clear command with a description", async () => {
    const mockPi = createMockPi();
    await clearExtension(mockPi);

    expect(mockPi.registerCommand).toHaveBeenCalledTimes(1);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "clear",
      expect.objectContaining({
        description: "Start a fresh Pi session (alias for /new)",
        handler: expect.any(Function),
      }),
    );
  });

  it("invokes newSession when /clear is run", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await clearExtension(mockPi);

    const handler = getCommandHandler(mockPi, "clear");
    await handler("", mockCtx);

    expect(mockCtx.newSession).toHaveBeenCalledTimes(1);
  });

  it("ignores trailing arguments", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await clearExtension(mockPi);

    const handler = getCommandHandler(mockPi, "clear");
    await handler("whatever the user typed", mockCtx);

    expect(mockCtx.newSession).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the new session is cancelled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.newSession = vi.fn(() => Promise.resolve({ cancelled: true }));
    await clearExtension(mockPi);

    const handler = getCommandHandler(mockPi, "clear");
    await handler("", mockCtx);

    expect(mockCtx.newSession).toHaveBeenCalledTimes(1);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });
});
