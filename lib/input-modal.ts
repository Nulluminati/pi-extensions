/** Single-line text prompt and yes/no confirmation rendered inside the shared modal frame. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input } from "@earendil-works/pi-tui";
import { setInputValue } from "./input-value.ts";
import { wrapToolText } from "./tool-renderer.ts";
import { modalContentWidth, renderModalFrame } from "./tui-frame.ts";
import { formatStyledKeyHints } from "./ui-format.ts";

interface InputModalTui {
  requestRender(): void;
}

interface InputModalTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface InputModalKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export interface InputModalOptions {
  tui: InputModalTui;
  theme: InputModalTheme;
  keybindings: InputModalKeybindings;
  title: string;
  placeholder: string;
  initialValue?: string | undefined;
  onSubmit(value: string): void;
  onCancel(): void;
}

export interface InputModal {
  focused: boolean;
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

export function createInputModal(options: InputModalOptions): InputModal {
  const input = new Input();
  if (options.initialValue !== undefined) setInputValue(input, options.initialValue);
  input.focused = true;

  return {
    focused: true,
    render: (width) => {
      const frameWidth = Math.max(0, Math.floor(width));
      if (frameWidth === 0) return [];
      const contentWidth = modalContentWidth(frameWidth);
      const lines = [
        options.theme.fg("muted", `${options.placeholder}:`),
        input.render(contentWidth)[0] ?? "",
        "",
        formatStyledKeyHints(options.theme, [
          ["enter", "submit"],
          ["esc", "cancel"],
        ]),
      ];
      return renderModalFrame(options.theme, frameWidth, lines, { title: options.title });
    },
    invalidate: () => input.invalidate(),
    handleInput: (data) => {
      if (options.keybindings.matches(data, "tui.select.confirm")) {
        options.onSubmit(input.getValue());
      } else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onCancel();
      } else {
        input.handleInput(data);
      }
      options.tui.requestRender();
    },
  };
}

export interface ConfirmModalOptions {
  tui: InputModalTui;
  theme: InputModalTheme;
  keybindings: InputModalKeybindings;
  title: string;
  /** Body text; long lines are word-wrapped to the frame width. */
  body: string;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Yes/no dialog in the shared modal frame. Enter confirms, Esc cancels. The
 * body is word-wrapped so long explanations stay fully visible.
 */
export function createConfirmModal(options: ConfirmModalOptions): InputModal {
  return {
    focused: true,
    render: (width) => {
      const frameWidth = Math.max(0, Math.floor(width));
      if (frameWidth === 0) return [];
      const contentWidth = modalContentWidth(frameWidth);
      const lines = [
        ...wrapToolText(options.body, contentWidth),
        "",
        formatStyledKeyHints(options.theme, [
          ["enter", options.confirmLabel ?? "confirm"],
          ["esc", options.cancelLabel ?? "cancel"],
        ]),
      ];
      return renderModalFrame(options.theme, frameWidth, lines, { title: options.title });
    },
    invalidate: () => {},
    handleInput: (data) => {
      if (options.keybindings.matches(data, "tui.select.confirm")) {
        options.onConfirm();
      } else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onCancel();
      }
      options.tui.requestRender();
    },
  };
}

export interface ConfirmOptions {
  title: string;
  /** Body text; long lines are word-wrapped to the frame width. */
  body: string;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
}

/**
 * Ask a yes/no question in a framed modal matching the repo's shared dialog
 * styling. Outside TUI mode, falls back to the plain `ctx.ui.confirm` dialog.
 * Without UI, resolves `false`, matching pi's no-op confirm context.
 */
export async function confirmModal(
  ctx: ExtensionCommandContext,
  options: ConfirmOptions,
): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm(options.title, options.body);
  }
  return ctx.ui.custom<boolean>(
    (tui, theme, keybindings, done) =>
      createConfirmModal({
        tui,
        theme,
        keybindings,
        title: options.title,
        body: options.body,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        onConfirm: () => done(true),
        onCancel: () => done(false),
      }),
    // Report pi as waiting for an answer so terminals with program status
    // (OSC 7501) show it as blocked while the dialog is open.
    { blocked: { kind: "permission", message: options.title } },
  );
}

export interface PromptTextOptions {
  title: string;
  placeholder: string;
  initialValue?: string | undefined;
}

/**
 * Prompt for one line of text in a framed modal matching the repo's shared
 * dialog styling. Outside TUI mode (or without UI), falls back to the plain
 * `ctx.ui.input` dialog. Resolves `undefined` when the user cancels.
 */
export async function promptText(
  ctx: ExtensionCommandContext,
  options: PromptTextOptions,
): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (!ctx.hasUI) return undefined;
    return ctx.ui.input(options.title, options.initialValue ?? options.placeholder);
  }
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) =>
      createInputModal({
        tui,
        theme,
        keybindings,
        title: options.title,
        placeholder: options.placeholder,
        initialValue: options.initialValue,
        onSubmit: (value) => done(value),
        onCancel: () => done(undefined),
      }),
    // Report pi as waiting for an answer so terminals with program status
    // (OSC 7501) show it as blocked while the dialog is open.
    { blocked: { kind: "question", message: options.title } },
  );
}
