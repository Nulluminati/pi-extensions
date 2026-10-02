import { describe, expect, it, vi } from "vitest";
import { createApprovalDialog, promptApproval } from "../../extensions/approval-mode/src/dialog.ts";
import { PANEL_OVERLAY_OPTIONS } from "../../lib/overlay-options.ts";
import { createMockContext } from "../mocks/context-mocks.ts";

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

describe("promptApproval abort handling", () => {
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

  /** Stub ui.custom to invoke the factory synchronously and capture the component. */
  function captureDialog(ctx: ReturnType<typeof createMockContext>) {
    let component: ReturnType<typeof createApprovalDialog> | undefined;
    let doneCalls = 0;
    ctx.ui.custom = vi.fn(
      (factory) =>
        new Promise((resolve) => {
          const opened = factory(
            { requestRender: vi.fn() },
            theme,
            keybindings,
            (value: unknown) => {
              doneCalls++;
              resolve(value);
            },
          );
          // The factory under test is synchronous; the component it builds is
          // createApprovalDialog's return plus the dispose override.
          if (!(opened instanceof Promise)) {
            component = opened as ReturnType<typeof createApprovalDialog>;
          }
        }),
    );
    return {
      get component(): ReturnType<typeof createApprovalDialog> {
        if (!component) throw new Error("dialog factory never produced a component");
        return component;
      },
      get doneCalls() {
        return doneCalls;
      },
    };
  }

  it("settles Block once when the signal aborts while the dialog is open", async () => {
    const ctx = createMockContext();
    const controller = new AbortController();
    ctx.signal = controller.signal as unknown as typeof ctx.signal;
    const dialog = captureDialog(ctx);

    const pending = promptApproval(ctx, "git push origin main", "reject", "Jev rejected this");
    controller.abort();
    const choice = await pending;

    expect(choice).toBe("Block");
    expect(dialog.doneCalls).toBe(1);
    dialog.component.render(70);
    dialog.component.handleInput("up");
    dialog.component.handleInput("enter");
    expect(dialog.doneCalls).toBe(1);
  });

  it("keeps the user's choice when the signal aborts after selection", async () => {
    const ctx = createMockContext();
    const controller = new AbortController();
    ctx.signal = controller.signal as unknown as typeof ctx.signal;
    const dialog = captureDialog(ctx);

    const pending = promptApproval(ctx, "git push origin main", "reject", "Jev rejected this");
    dialog.component.render(70);
    dialog.component.handleInput("up");
    dialog.component.handleInput("enter");
    expect(await pending).toBe("Approve once");

    controller.abort();
    expect(dialog.doneCalls).toBe(1);
  });

  it("settles Block immediately when the signal was already aborted", async () => {
    const ctx = createMockContext();
    const controller = new AbortController();
    ctx.signal = controller.signal as unknown as typeof ctx.signal;
    controller.abort();
    const dialog = captureDialog(ctx);

    const choice = await promptApproval(ctx, "git push origin main", "reject", "Jev rejected this");

    expect(choice).toBe("Block");
    expect(dialog.doneCalls).toBe(1);
  });
});

describe("promptApproval overlay capture", () => {
  it("opens a focused panel overlay so page keys reach the dialog", async () => {
    const ctx = createMockContext();
    ctx.ui.custom = vi.fn(() => Promise.resolve("Block" as const));

    await promptApproval(ctx, "git push origin main", "reject", "Jev rejected this");

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    const [factory, options] = ctx.ui.custom.mock.calls[0];
    expect(factory).toBeTypeOf("function");
    expect(options).toMatchObject({
      overlay: true,
      overlayOptions: { ...PANEL_OVERLAY_OPTIONS, maxHeight: "100%" },
    });
    const handle = { focus: vi.fn() };
    (options?.onHandle as ((focused: { focus: () => void }) => void) | undefined)?.(handle);
    expect(handle.focus).toHaveBeenCalledTimes(1);
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
