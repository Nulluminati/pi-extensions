import { describe, expect, it } from "vitest";
import { PANEL_OVERLAY_OPTIONS } from "../../lib/overlay-options.ts";

describe("panel overlay options", () => {
  it("centers a panel at 70% width and at most 80% height", () => {
    expect(PANEL_OVERLAY_OPTIONS).toEqual({
      width: "70%",
      maxHeight: "80%",
      anchor: "center",
    });
  });
});
