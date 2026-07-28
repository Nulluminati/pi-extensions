import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { frameBorderLine, frameContentLine, frameRuleLine } from "../../lib/tui-frame.ts";

const ANSI_THEME = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
};

describe("TUI frame helpers", () => {
  it("renders borders and rules at the requested visible width", () => {
    expect(frameBorderLine(ANSI_THEME, 8, "top")).toContain("╭──────╮");
    expect(frameRuleLine(ANSI_THEME, 8)).toContain("├──────┤");
    expect(frameBorderLine(ANSI_THEME, 8, "bottom")).toContain("╰──────╯");

    expect(visibleWidth(frameBorderLine(ANSI_THEME, 8, "top"))).toBe(8);
    expect(visibleWidth(frameRuleLine(ANSI_THEME, 8))).toBe(8);
    expect(visibleWidth(frameBorderLine(ANSI_THEME, 8, "bottom"))).toBe(8);
  });

  it("clips long content by visible width", () => {
    const line = frameContentLine(ANSI_THEME, 12, "content that is too long");

    expect(visibleWidth(line)).toBe(12);
    expect(line).toContain("│");
    expect(line).toContain("…");
  });

  it("pads ANSI-styled content by visible width", () => {
    const line = frameContentLine(ANSI_THEME, 12, "\x1b[32mcolor\x1b[0m");

    expect(visibleWidth(line)).toBe(12);
    expect(line).toContain("\x1b[32mcolor\x1b[0m");
  });

  it("handles wide Unicode without exceeding the requested width", () => {
    const line = frameContentLine(ANSI_THEME, 9, "音声入力テスト");

    expect(visibleWidth(line)).toBe(9);
  });

  it("keeps every frame primitive within narrow widths", () => {
    for (const width of [0, 1, 2, 3]) {
      const lines = [
        frameBorderLine(ANSI_THEME, width, "top"),
        frameContentLine(ANSI_THEME, width, "content"),
        frameRuleLine(ANSI_THEME, width),
        frameBorderLine(ANSI_THEME, width, "bottom"),
      ];

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});
