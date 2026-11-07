import { describe, expect, it } from "vitest";
import { formatTokenCount } from "../../lib/token-count.ts";

describe("formatTokenCount", () => {
  it("keeps model-picker labels by default", () => {
    expect(formatTokenCount(0)).toBe("0k");
    expect(formatTokenCount(999)).toBe("1k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(1_000_000)).toBe("1m");
  });

  it("keeps context labels with fixed tenths", () => {
    const context = { underThousand: "raw", thousands: "fixed", millions: "fixed" } as const;
    expect(formatTokenCount(999, context)).toBe("999");
    expect(formatTokenCount(1500, context)).toBe("1.5k");
    expect(formatTokenCount(1_000_000, context)).toBe("1.0m");
  });
});
