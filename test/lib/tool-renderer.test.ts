import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createToolStatus, wrapToolText } from "../../lib/tool-renderer.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("tool renderer helpers", () => {
  it("creates a width-safe one-line tool status", () => {
    const component = createToolStatus(theme, "success", "Search: complete");

    const lines = component.render(12);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(12);
  });

  it("wraps each source line while preserving blank lines", () => {
    expect(wrapToolText("first line\n\nsecond line", 8)).toEqual([
      "first",
      "line",
      "",
      "second",
      "line",
    ]);
  });
});
