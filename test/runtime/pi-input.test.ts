import { describe, expect, it, vi } from "vitest";
import { createApprovalDialog } from "../../extensions/approval-mode/src/dialog.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

async function renderer(rows = 24) {
  const { TuiAltScreen, getKeybindings } = await import(
    import.meta.resolve("@earendil-works/pi-tui")
  );
  const terminal = {
    rows,
    columns: 80,
    start: vi.fn(),
    stop: vi.fn(),
    write: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
  };
  const tui = new TuiAltScreen(terminal);
  return { tui, terminal, keybindings: getKeybindings() };
}

describe("real fullscreen input dispatch", () => {
  it("delivers page keys to a focused approval overlay", async () => {
    const { tui, keybindings } = await renderer();
    const done = vi.fn();
    const dialog = createApprovalDialog({
      command: Array.from({ length: 13 }, (_, index) => `step ${index}`).join("\n"),
      reason: "Test reason",
      decision: "reject",
      tui,
      theme,
      keybindings,
      done,
    });
    dialog.render(56);
    const handle = tui.showOverlay(dialog, { width: "70%", maxHeight: "100%", anchor: "center" });
    handle.focus();
    tui.handleTerminalInput("\x1b[A");
    tui.handleTerminalInput("\r");
    expect(done).not.toHaveBeenCalled();
    tui.handleTerminalInput("\x1b[6~");
    expect(dialog.render(56).join("\n")).toContain("6-13/13");
    tui.handleTerminalInput("\r");
    expect(done).toHaveBeenCalledWith("Approve once");
    handle.hide();
  });

  it.each([18, 24])("keeps approval controls visible in a %i-row terminal", async (rows) => {
    const { tui, keybindings } = await renderer(rows);
    const done = vi.fn();
    const dialog = createApprovalDialog({
      command: Array.from({ length: 13 }, (_, index) => `step ${index}`).join("\n"),
      reason: "Long review reason. ".repeat(40),
      decision: "uncertain",
      tui,
      theme,
      keybindings,
      done,
    });
    const lines = dialog.render(56);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.join("\n")).toContain("enter: select");
    expect(lines.join("\n")).toContain("Block");
    dialog.handleInput("\x1b[A");
    dialog.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    let lastPage = "";
    for (let index = 0; index < 13; index++) {
      dialog.handleInput("\x1b[6~");
      const page = dialog.render(56);
      expect(page.length).toBeLessThanOrEqual(rows);
      lastPage = page.join("\n");
      if (lastPage.includes("step 12")) break;
    }
    expect(lastPage).toContain("step 12");
    dialog.handleInput("\r");
    expect(done).toHaveBeenCalledWith("Approve once");
  });

  it("cannot approve through page keys when the terminal is too small for review", async () => {
    const { tui, keybindings } = await renderer(8);
    const done = vi.fn();
    const dialog = createApprovalDialog({
      command: "git push",
      reason: "Test reason",
      decision: "reject",
      tui,
      theme,
      keybindings,
      done,
    });
    expect(dialog.render(56).join("\n")).toContain("Resize the terminal");
    dialog.handleInput("\x1b[A");
    dialog.handleInput("\x1b[6~");
    dialog.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith("Block");
  });

  it("restores transcript wheel scrolling after a focused overlay closes", async () => {
    const { tui, terminal } = await renderer();
    const inputHistory = vi.fn();
    const transcript = {
      render: () => Array.from({ length: 100 }, (_, index) => `line ${index}`),
      invalidate() {},
      handleInput: inputHistory,
    };
    tui.addChild(transcript);
    tui.setFocus(transcript);
    tui.start();
    try {
      tui.renderNow();
      const handle = tui.showOverlay({
        render: () => ["panel"],
        invalidate() {},
        handleInput() {},
      });
      handle.focus();
      tui.renderNow();
      handle.hide();
      tui.renderNow();
      expect(tui.getFocusedComponent()).toBe(transcript);
      const before = tui.viewportTop;
      tui.handleTerminalInput("\x1b[<64;40;10M");
      expect(tui.viewportTop).toBeLessThan(before);
      expect(inputHistory).not.toHaveBeenCalled();
      expect(terminal.write.mock.calls.flat().join(" ")).not.toContain("\x1b[?1006l");
    } finally {
      tui.stop();
    }
  });
});
