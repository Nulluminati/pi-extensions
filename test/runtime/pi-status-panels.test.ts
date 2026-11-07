import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderEditorModalFrame } from "../../extensions/status-bar/src/editor.ts";
import { buildFooterLines } from "../../extensions/status-bar/src/footer.ts";
import type { State } from "../../extensions/status-bar/src/types.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";

function state(): State {
  return {
    enabled: true,
    turnCount: 12,
    thinkingLevel: "high",
    smallModelLabel: "",
    workerModelLabel: "",
    gitBranch: "feature/世界/with-a-branch-name-that-wraps-across-the-panel",
    gitStatus: null,
    tokenUsage: { input: 1200, output: 300, cacheRead: 400, cacheWrite: 50, cost: 0.123 },
    contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
    lastHandle: null,
    flexOn: false,
    flexCapable: false,
    approvalModeOff: false,
    unreadMail: 3,
    workerCostUsd: 0.04,
    workerTokens: 38100,
  };
}

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` };

describe("status panels with real Pi text helpers", () => {
  it("bounds styled lines across resize widths and preserves wrapped text", () => {
    const ctx = createMockCommandContext();
    ctx.cwd = "/projects/工作区";
    const snapshot = state();
    const status =
      "Third-party status with enough detail to wrap across multiple terminal rows 世界";
    const data = { getExtensionStatuses: () => new Map([["other", status]]) };
    for (let width = 0; width <= 180; width++) {
      const lines = buildFooterLines(snapshot, ctx, theme, data, width, 10000);
      for (const line of lines) {
        expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
        if (width >= 12 && /^[╭│╰]/u.test(stripVTControlCharacters(line))) {
          expect(visibleWidth(line), `panel width ${width}`).toBe(width);
        }
      }
      if (width < 24) continue;
      const text = lines.map(stripVTControlCharacters).join("\n");
      for (const value of [
        "Workspace",
        "Context",
        "Session",
        "工作区",
        "50.0k/200.0k",
        "$0.123",
        "✉ 3",
        "⚙ $0.04",
        "38.1k",
      ]) {
        expect(text, `width ${width}`).toContain(value);
      }
      // Ignore frame strokes and whitespace to reconstruct wrapped values.
      const compact = text.replace(/[╭╮╰╯│─\s]/gu, "");
      expect(compact).toContain(snapshot.gitBranch);
      expect(compact).toContain(status.replace(/\s/gu, ""));
    }
  });

  it("keeps the editor cursor visible as terminal height and width change", () => {
    const ctx = createMockCommandContext();
    const snapshot = state();
    const status = `status-start ${"x".repeat(1200)} status-end`;
    const data = { getExtensionStatuses: () => new Map([["other", status]]) };
    for (const width of [40, 160]) {
      for (const height of [120, 24, 12, 8, 6, 5, 0, 24, 120]) {
        const footer = buildFooterLines(snapshot, ctx, theme, data, width, height);
        const budget = Math.max(0, Math.min(Math.floor(height / 2), height - 6));
        expect(footer.length, `${width}x${height}`).toBeLessThanOrEqual(budget);
        for (const line of footer) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (height < 6) continue;
        const editor = renderEditorModalFrame({
          baseRendered: ["─", `${CURSOR_MARKER}prompt`, "─"],
          autocompleteCount: 0,
          width,
          title: "test/model",
          theme,
        });
        // Pi's regular renderer searches only the bottom terminal-height rows for the cursor.
        const viewport = [...editor, ...footer].slice(-height);
        expect(
          viewport.some((line) => line.includes(CURSOR_MARKER)),
          `${width}x${height}`,
        ).toBe(true);
        const text = footer.map(stripVTControlCharacters).join("\n");
        if (height === 24) expect(text).toMatch(/↓ \d+ more lines/);
        if (height === 120) {
          expect(text).not.toContain("more lines");
          expect(text.replace(/[╭╮╰╯│─\s]/gu, "")).toContain(status.replace(/\s/gu, ""));
        }
      }
    }
  });

  it("shows all rows at the height limit and an accurate overflow count below it", () => {
    const ctx = createMockCommandContext();
    const snapshot = state();
    snapshot.gitBranch = "main";
    const data = {
      getExtensionStatuses: () =>
        new Map([
          ["first", "first status"],
          ["second", "second status"],
        ]),
    };
    const exact = buildFooterLines(snapshot, ctx, theme, data, 160, 14);
    expect(exact).toHaveLength(7);
    expect(exact.map(stripVTControlCharacters).join("\n")).toContain("second status");
    expect(exact.join("\n")).not.toContain("more lines");
    const overflow = buildFooterLines(snapshot, ctx, theme, data, 160, 12);
    expect(overflow).toHaveLength(6);
    expect(stripVTControlCharacters(overflow.at(-1) ?? "")).toBe("↓ 2 more lines");
    expect(overflow.map(stripVTControlCharacters).join("\n")).not.toContain("first status");
  });

  it("uses compact panel rows when panel contents exceed the height budget", () => {
    const ctx = createMockCommandContext();
    const snapshot = state();
    snapshot.gitBranch = "branch/".repeat(200);
    const lines = buildFooterLines(snapshot, ctx, theme, {}, 40, 24);
    expect(lines.length).toBeLessThanOrEqual(12);
    const text = lines.map(stripVTControlCharacters).join("\n");
    for (const value of ["Workspace", "Context", "Session", "$0.123", "✉ 3", "⚙ $0.04"]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("…");
  });

  it("redraws with the supplied theme and leaves missing context unknown", () => {
    const ctx = createMockCommandContext();
    const snapshot = state();
    snapshot.contextUsage = undefined;
    const first = buildFooterLines(snapshot, ctx, theme, {}, 160);
    const plain = buildFooterLines(
      snapshot,
      ctx,
      { fg: (_color: string, text: string) => text },
      {},
      160,
    );
    expect(first.join("\n")).toContain("\x1b[36m");
    expect(plain.join("\n")).not.toContain("\x1b");
    expect(plain.join("\n")).not.toContain("50.0k/200.0k");
    expect(plain.join("\n")).toContain("↑1.2k");
  });
});
