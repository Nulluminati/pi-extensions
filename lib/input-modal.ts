/** Single-line text prompt rendered inside the shared modal frame. */

import { Input } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
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
  if (options.initialValue !== undefined) input.setValue(options.initialValue);
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
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
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
  );
}
