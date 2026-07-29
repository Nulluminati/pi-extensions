import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  frameBorderLine,
  frameContentLine,
  frameRuleLine,
  modalContentWidth,
  renderModalFrame,
} from "../../lib/tui-frame.ts";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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

  it("renders a padded Peon-style modal with an inline concise title", () => {
    const lines = renderModalFrame(ANSI_THEME, 30, ["content"], { title: "Voice" });

    expect(lines[0]?.replace(ANSI_PATTERN, "")).toContain("╭── Voice ");
    expect(lines[1]?.replace(ANSI_PATTERN, "")).toContain("│");
    expect(lines[2]?.replace(ANSI_PATTERN, "")).toContain("  content");
    expect(lines.at(-1)?.replace(ANSI_PATTERN, "")).toContain("╰");
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(modalContentWidth(30)).toBe(24);
  });

  it("replaces overflowing fixed-height content with an indicator", () => {
    const lines = renderModalFrame(ANSI_THEME, 30, ["one", "two", "three"], {
      title: "BTW",
      paddingY: 0,
      fixedBodyRows: 2,
    });

    expect(lines.join("\n")).toContain("↓ 2 more lines");
    expect(lines.join("\n")).not.toContain("three");
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

  it("renders a raw (pre-colored) title without re-wrapping it in accent", () => {
    // rawTitle must size the border by visible width (ignoring ANSI) and emit
    // the title verbatim instead of wrapping it in fg("accent", …).
    const theme = {
      fg: (color: string, text: string) =>
        color === "accent" ? `\x1b[35m${text}\x1b[0m` : `\x1b[36m${text}\x1b[0m`,
    };
    const coloredTitle = `${theme.fg("accent", "synthetic")}/haiku`;
    const lines = renderModalFrame(theme, 30, ["content"], {
      title: coloredTitle,
      rawTitle: true,
    });

    // The raw title bytes survive intact, and the top border still fits 30 cols.
    expect(lines[0]).toContain(coloredTitle);
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
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
