import { describe, expect, it, vi } from "vitest";
import {
  confirmModal,
  createConfirmModal,
  createInputModal,
  promptText,
} from "../../lib/input-modal.ts";
import { mockFn } from "../mocks/mock-types.ts";
import { fakeTui } from "../mocks/test-helpers.ts";

function createModal(
  overrides: { onSubmit?: (value: string) => void; onCancel?: () => void } = {},
) {
  const requestRender = vi.fn();
  const onSubmit = overrides.onSubmit ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  const modal = createInputModal({
    tui: { requestRender },
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
    keybindings: { matches: matchesKey },
    title: "Goal objective",
    placeholder: "What should this run accomplish?",
    onSubmit,
    onCancel,
  });
  return { modal, requestRender, onSubmit, onCancel };
}

describe("createInputModal", () => {
  it("renders inside the shared modal frame with title and key hints", () => {
    const { modal } = createModal();
    const rendered = modal.render(60).join("\n");

    expect(rendered).toContain("╭── Goal objective ");
    expect(rendered).toContain("enter: submit · esc: cancel");
  });

  it("seeds the input with initialValue for prefilled editing", () => {
    const onSubmit = vi.fn();
    const modal = createInputModal({
      tui: fakeTui(),
      theme: { fg: (_c, t) => t, bold: (t) => t },
      keybindings: { matches: matchesKey },
      title: "Edit goal objective",
      placeholder: "objective",
      initialValue: "implement snake game",
      onSubmit,
      onCancel: vi.fn(),
    });

    expect(modal.render(80).join("\n")).toContain("implement snake game");
    modal.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("implement snake game");
  });

  it("submits typed text on enter", () => {
    const { modal, onSubmit } = createModal();
    for (const character of "ship it") modal.handleInput(character);
    modal.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("cancels on escape without submitting", () => {
    const { modal, onSubmit, onCancel } = createModal();
    modal.handleInput("a");
    modal.handleInput("");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requests a render after each keystroke", () => {
    const { modal, requestRender } = createModal();
    modal.handleInput("a");
    modal.handleInput("b");

    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});

describe("promptText", () => {
  it("resolves with the submitted value", async () => {
    const ctx = createMockPromptContext();
    ctx.ui.custom = mockFn((factory: (...args: unknown[]) => unknown) => {
      return new Promise((resolve) => {
        const component = factory(fakeTui(), ctx.ui.theme, { matches: matchesKey }, resolve) as {
          handleInput(data: string): void;
        };
        for (const character of "my goal") component.handleInput(character);
        component.handleInput("\r");
      });
    });

    await expect(promptText(ctx, { title: "Goal", placeholder: "goal" })).resolves.toBe("my goal");
  });

  it("resolves undefined when cancelled", async () => {
    const ctx = createMockPromptContext();
    ctx.ui.custom = mockFn((factory: (...args: unknown[]) => unknown) => {
      return new Promise((resolve) => {
        const component = factory(fakeTui(), ctx.ui.theme, { matches: matchesKey }, resolve) as {
          handleInput(data: string): void;
        };
        component.handleInput("");
      });
    });

    await expect(promptText(ctx, { title: "Goal", placeholder: "goal" })).resolves.toBeUndefined();
  });

  it("falls back to ctx.ui.input outside TUI mode", async () => {
    const ctx = createMockPromptContext();
    ctx.mode = "rpc";
    ctx.ui.input = vi.fn(() => Promise.resolve("typed inline"));

    await expect(
      promptText(ctx, { title: "Goal", placeholder: "goal", initialValue: "seed" }),
    ).resolves.toBe("typed inline");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.input).toHaveBeenCalledWith("Goal", "seed");
  });
});

describe("createConfirmModal", () => {
  function createConfirm(overrides: { onConfirm?: () => void; onCancel?: () => void } = {}) {
    const requestRender = vi.fn();
    const onConfirm = overrides.onConfirm ?? vi.fn();
    const onCancel = overrides.onCancel ?? vi.fn();
    const modal = createConfirmModal({
      tui: { requestRender },
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
      },
      keybindings: { matches: matchesKey },
      title: "Start a fresh session?",
      body: "This replaces the current session.\nThe old session stays in your history.",
      onConfirm,
      onCancel,
    });
    return { modal, requestRender, onConfirm, onCancel };
  }

  it("renders inside the shared modal frame with title, body, and key hints", () => {
    const { modal } = createConfirm();
    const rendered = modal.render(60).join("\n");

    expect(rendered).toContain("╭── Start a fresh session? ");
    expect(rendered).toContain("This replaces the current session.");
    expect(rendered).toContain("enter: confirm · esc: cancel");
  });

  it("wraps long body lines to the frame width instead of truncating", () => {
    const modal = createConfirmModal({
      tui: fakeTui(),
      theme: { fg: (_color, text) => text, bold: (text) => text },
      keybindings: { matches: matchesKey },
      title: "Replace current goal?",
      body: "Current goal: implement snake game with menus\nNew goal: write a platformer\n\nThis will reset usage counters.",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = modal.render(40).join("\n");
    expect(rendered).toContain("This will reset usage counters.");
    expect(rendered).not.toContain("…");
  });

  it("confirms on enter", () => {
    const { modal, onConfirm, onCancel } = createConfirm();
    modal.handleInput("\r");

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on escape without confirming", () => {
    const { modal, onConfirm, onCancel } = createConfirm();
    modal.handleInput("\x1b");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requests a render after input", () => {
    const { modal, requestRender } = createConfirm();
    modal.handleInput("\r");

    expect(requestRender).toHaveBeenCalledTimes(1);
  });
});

describe("confirmModal", () => {
  it("resolves true when confirmed in TUI mode", async () => {
    const ctx = createMockPromptContext();
    ctx.ui.custom = mockFn((factory: (...args: unknown[]) => unknown) => {
      return new Promise((resolve) => {
        const component = factory(fakeTui(), ctx.ui.theme, { matches: matchesKey }, resolve) as {
          handleInput(data: string): void;
        };
        component.handleInput("\r");
      });
    });

    await expect(confirmModal(ctx, { title: "Confirm", body: "Proceed?" })).resolves.toBe(true);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("resolves false when cancelled in TUI mode", async () => {
    const ctx = createMockPromptContext();
    ctx.ui.custom = mockFn((factory: (...args: unknown[]) => unknown) => {
      return new Promise((resolve) => {
        const component = factory(fakeTui(), ctx.ui.theme, { matches: matchesKey }, resolve) as {
          handleInput(data: string): void;
        };
        component.handleInput("\x1b");
      });
    });

    await expect(confirmModal(ctx, { title: "Confirm", body: "Proceed?" })).resolves.toBe(false);
  });

  it("falls back to ctx.ui.confirm outside TUI mode", async () => {
    const ctx = createMockPromptContext();
    ctx.mode = "rpc";
    ctx.ui.confirm = vi.fn(() => Promise.resolve(true));

    await expect(confirmModal(ctx, { title: "Confirm", body: "Proceed?" })).resolves.toBe(true);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Confirm", "Proceed?");
  });

  it("resolves false without UI", async () => {
    const ctx = createMockPromptContext();
    ctx.hasUI = false;

    await expect(confirmModal(ctx, { title: "Confirm", body: "Proceed?" })).resolves.toBe(false);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});

function matchesKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["", ""],
  };
  return keys[keybinding]?.includes(data) ?? false;
}

// Minimal stand-in for ExtensionCommandContext; only the pieces promptText touches.
// biome-ignore lint/suspicious/noExplicitAny: test mock
function createMockPromptContext(): any {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      custom: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
    },
  };
}
