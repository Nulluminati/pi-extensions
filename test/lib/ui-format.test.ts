import { describe, expect, it } from "vitest";
import { formatKeyHints, formatStatusLine } from "../../lib/ui-format.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("UI formatting", () => {
  it("formats keyboard hints with consistent lowercase keys and actions", () => {
    expect(
      formatKeyHints([
        ["enter", "select"],
        ["esc", "cancel"],
      ]),
    ).toBe("enter: select · esc: cancel");
  });

  it("formats prefixed status lines with consistent icon and text styling", () => {
    expect(
      formatStatusLine(theme, {
        icon: "◆",
        prefix: "Small Model",
        text: "anthropic/haiku · minimal",
      }),
    ).toBe("<accent>◆</accent> <muted>Small Model: anthropic/haiku · minimal</muted>");
  });

  it("supports extension-specific status colors", () => {
    expect(
      formatStatusLine(theme, {
        icon: "◆",
        prefix: "Goal",
        text: "active",
        iconColor: "success",
        textColor: "text",
      }),
    ).toContain("<success>◆</success> <text>Goal: active</text>");
  });
});
