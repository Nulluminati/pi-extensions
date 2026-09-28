import { describe, expect, it, vi } from "vitest";
import { createApprovalDialog } from "../../extensions/approval-mode/src/dialog.ts";

describe("Approval Mode confirmation dialog", () => {
  it("uses the shared frame and defaults to Block", () => {
    const { component, done } = setup("git push origin feature/auth");
    const lines = component.render(70);
    expect(lines[0]).toContain("Approval Mode");
    expect(lines.join("\n")).toContain("git push origin feature/auth");
    expect(lines.join("\n")).toContain("enter: select");
    expect(lines.join("\n")).toContain("Block");
    component.handleInput("enter");
    expect(done).toHaveBeenCalledWith("Block");
  });

  it("allows one call only after explicit selection", () => {
    const { component, done } = setup("git push origin feature/auth");
    component.render(70);
    component.handleInput("up");
    component.handleInput("enter");
    expect(done).toHaveBeenCalledWith("Approve once");
  });

  it("requires review of every command line before approval", () => {
    const { component, done } = setup(Array.from({ length: 13 }, (_, i) => `step ${i}`).join("\n"));
    component.render(70);
    component.handleInput("up");
    component.handleInput("enter");
    expect(done).not.toHaveBeenCalled();
    expect(component.render(70).join("\n")).toContain("Review all command lines");
    component.handleInput("pageDown");
    component.handleInput("enter");
    expect(done).toHaveBeenCalledWith("Approve once");
  });

  it("does not hide the end of an unbroken command", () => {
    const { component, done } = setup(`${"a".repeat(200)}; git push origin feature/auth`);
    component.render(28);
    component.handleInput("up");
    component.handleInput("enter");
    expect(done).not.toHaveBeenCalled();
    let lastPage = "";
    for (let index = 0; index < 20; index++) {
      component.handleInput("pageDown");
      lastPage = component.render(28).join("\n");
      if (lastPage.includes("feature/auth")) break;
    }
    expect(lastPage).toContain("feature/auth");
    component.handleInput("enter");
    expect(done).toHaveBeenCalledWith("Approve once");
  });

  it("makes terminal control characters visible and fits narrow widths", () => {
    const { component } = setup("printf '\u001b[31m'\nnext");
    const lines = component.render(28);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toContain("\\x1b");
    expect(lines.every((line) => line.length <= 28)).toBe(true);
  });

  it("blocks on escape without requiring command review", () => {
    const { component, done } = setup(Array.from({ length: 13 }, (_, i) => `step ${i}`).join("\n"));
    component.render(70);
    component.handleInput("escape");
    expect(done).toHaveBeenCalledWith("Block");
  });
});

function setup(command: string) {
  const done = vi.fn();
  const tui = { requestRender: vi.fn() };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const bindings: Record<string, string> = {
    enter: "tui.select.confirm",
    escape: "tui.select.cancel",
    up: "tui.select.up",
    down: "tui.select.down",
    pageUp: "tui.select.pageUp",
    pageDown: "tui.select.pageDown",
  };
  const keybindings = { matches: (data: string, binding: string) => bindings[data] === binding };
  const component = createApprovalDialog({
    command,
    reason: "The command changes resources outside the project",
    decision: "reject",
    tui,
    theme,
    keybindings,
    done,
  });
  return { component, done, tui };
}
