import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
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
    goalRunning: false,
    goalIteration: 0,
    goalCap: null,
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
      const lines = buildFooterLines(snapshot, ctx, theme, data, width);
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
