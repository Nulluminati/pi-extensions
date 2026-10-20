import { describe, expect, it, vi } from "vitest";
import { createMockContext } from "./context-mocks.ts";
import { createMockPi } from "./pi-mocks.ts";

// Each @ts-expect-error below is a compile-time assertion: tsc fails with
// "Unused '@ts-expect-error' directive" if a mock stops checking that shape.
describe("typed Pi mocks", () => {
  it("rejects return values the real Pi API cannot produce", () => {
    const pi = createMockPi();
    // @ts-expect-error getThinkingLevel returns a ThinkingLevel, not a number
    pi.getThinkingLevel.mockReturnValue(123);
    pi.getThinkingLevel.mockReturnValue("high");
    expect(pi.getThinkingLevel()).toBe("high");
  });

  it("rejects implementations with the wrong parameters", () => {
    const ctx = createMockContext();
    // @ts-expect-error notify takes a message string first
    ctx.ui.notify.mockImplementation((message: number) => void message);
    ctx.ui.notify("saved", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("saved", "info");
  });

  it("rejects replacement mocks with the wrong return type", () => {
    const ctx = createMockContext();
    // @ts-expect-error getSessionId returns a string
    ctx.sessionManager.getSessionId = vi.fn(() => 42);
    ctx.sessionManager.getSessionId = vi.fn(() => "session-2");
    expect(ctx.sessionManager.getSessionId()).toBe("session-2");
  });
});
