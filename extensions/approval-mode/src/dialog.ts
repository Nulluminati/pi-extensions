/** Framed, single-call approval with a reviewable command and a safe default. */

import { SelectList, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { createSettleOnce } from "../../../lib/settle-once.ts";
import { modalContentWidth, renderModalFrame } from "../../../lib/tui-frame.ts";
import { formatStyledKeyHints } from "../../../lib/ui-format.ts";

export type ApprovalChoice = "Approve once" | "Block";

interface DialogTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  bg?(color: string, text: string): string;
}

interface DialogOptions {
  command: string;
  reason: string;
  decision: "reject" | "uncertain";
  tui: { requestRender(): void };
  theme: DialogTheme;
  keybindings: { matches(data: string, keybinding: string): boolean };
  done(choice: ApprovalChoice): void;
}

const COMMAND_ROWS = 8;

function visibleCommand(command: string): string {
  let visible = "";
  for (const char of command) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 10) || code === 127;
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    visible +=
      control || bidi
        ? code < 256
          ? `\\x${code.toString(16).padStart(2, "0")}`
          : `\\u${code.toString(16).padStart(4, "0")}`
        : char;
  }
  return visible;
}

export function createApprovalDialog(options: DialogOptions) {
  const { command, reason, decision, tui, theme, keybindings, done } = options;
  const selector = new SelectList(
    [
      { value: "Approve once", label: "Approve once" },
      { value: "Block", label: "Block" },
    ],
    2,
    {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) =>
        theme.bg?.("selectedBg", theme.fg("accent", text)) ?? theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  );
  // Do not use confirmModal here: Enter must never approve by default.
  // The selector starts on Block and requires review of every command line.
  selector.setSelectedIndex(1);
  let commandLines: string[] = [];
  let lastContentWidth = 0;
  let scrollTop = 0;
  let reviewedToEnd = false;
  let reviewWarning = false;
  let settled = false;

  return {
    render(width: number): string[] {
      const frameWidth = Math.max(0, Math.floor(width));
      if (frameWidth === 0) return [];
      const contentWidth = modalContentWidth(frameWidth);
      if (lastContentWidth !== contentWidth) {
        commandLines = visibleCommand(command)
          .split("\n")
          .flatMap((line) => wrapTextWithAnsi(line, contentWidth));
        lastContentWidth = contentWidth;
        scrollTop = 0;
        reviewedToEnd = commandLines.length <= COMMAND_ROWS;
        reviewWarning = false;
      }
      const maxScroll = Math.max(0, commandLines.length - COMMAND_ROWS);
      scrollTop = Math.min(scrollTop, maxScroll);
      const end = Math.min(commandLines.length, scrollTop + COMMAND_ROWS);
      const commandExcerpt = commandLines
        .slice(scrollTop, end)
        .map((line) => theme.fg("text", line));
      const indicator =
        commandLines.length > COMMAND_ROWS
          ? [`${scrollTop + 1}-${end}/${commandLines.length} lines (page up/down to review)`]
          : [];
      const body = [
        theme.fg(
          decision === "reject" ? "error" : "warning",
          `Jev ${decision === "reject" ? "rejected" : "could not confirm"} this command.`,
        ),
        ...wrapTextWithAnsi(reason, contentWidth).map((line) => theme.fg("muted", line)),
        "",
        theme.fg("muted", "Command:"),
        ...commandExcerpt,
        ...indicator.map((line) => theme.fg("dim", line)),
        "",
        theme.fg("text", "Approve this call only?"),
        ...selector.render(contentWidth),
        ...(reviewWarning
          ? [theme.fg("warning", "Review all command lines before approval.")]
          : []),
        "",
        formatStyledKeyHints(theme, [
          ["↑↓", "choose"],
          ["page up/down", "review command"],
          ["enter", "select"],
          ["esc", "block"],
        ]),
      ];
      return renderModalFrame(theme, frameWidth, body, { title: "Approval Mode", paddingY: 0 });
    },
    invalidate: () => selector.invalidate(),
    handleInput(data: string): void {
      if (settled) return;
      if (keybindings.matches(data, "tui.select.cancel")) {
        settled = true;
        done("Block");
      } else if (
        keybindings.matches(data, "tui.select.pageUp") ||
        keybindings.matches(data, "tui.select.pageDown")
      ) {
        const direction = keybindings.matches(data, "tui.select.pageDown") ? 1 : -1;
        const maxScroll = Math.max(0, commandLines.length - COMMAND_ROWS);
        scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + direction * COMMAND_ROWS));
        if (scrollTop === maxScroll) reviewedToEnd = true;
      } else if (
        keybindings.matches(data, "tui.select.up") ||
        keybindings.matches(data, "tui.select.down")
      ) {
        selector.setSelectedIndex(keybindings.matches(data, "tui.select.up") ? 0 : 1);
      } else if (keybindings.matches(data, "tui.select.confirm")) {
        const choice = selector.getSelectedItem()?.value as ApprovalChoice | undefined;
        if (choice === "Approve once" && !reviewedToEnd) {
          reviewWarning = true;
        } else if (choice !== undefined) {
          settled = true;
          done(choice);
        }
      }
      tui.requestRender();
    },
  };
}

export async function promptApproval(
  ctx: ExtensionContext,
  command: string,
  decision: "reject" | "uncertain",
  reason: string,
): Promise<ApprovalChoice | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(
      `Warning: Jev ${decision === "reject" ? "rejected" : "could not confirm"} this command.\n${reason}\n\n${command}\n\nApprove this call only?`,
      ["Approve once", "Block"],
      ctx.signal ? { signal: ctx.signal } : {},
    ) as Promise<ApprovalChoice | undefined>;
  }
  return ctx.ui.custom<ApprovalChoice>((tui, theme, keybindings, done) => {
    const handle = createSettleOnce(done, ctx.signal, "Block");
    // A signal already aborted before registration never fires its listener;
    // settle immediately so the dialog cannot hang on a dead context.
    if (ctx.signal?.aborted) handle.settle("Block");
    return {
      ...createApprovalDialog({
        command,
        reason,
        decision,
        tui,
        theme,
        keybindings,
        done: handle.settle,
      }),
      dispose: () => handle.dispose(),
    };
  });
}
