/** Framed, single-call approval with a reviewable command and a safe default. */

import { SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "pi";
import { PANEL_OVERLAY_OPTIONS } from "../../../lib/overlay-options.ts";
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
  source?: string;
  tui: { requestRender(): void; terminal?: { rows: number } };
  theme: DialogTheme;
  keybindings: { matches(data: string, keybinding: string): boolean };
  done(choice: ApprovalChoice): void;
}

const COMMAND_ROWS = 8;
// Borders, labels, choices, scroll indicator, and a reserved warning row.
const REVIEW_CONTROL_ROWS = 12;

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
  const { command, reason, decision, source, tui, theme, keybindings, done } = options;
  const reviewText = source ? `${source}\n\n${command}` : command;
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
  let commandRows = COMMAND_ROWS;
  let lastContentWidth = 0;
  let scrollTop = 0;
  let reviewedToEnd = false;
  let reviewAvailable = false;
  let reviewWarning = false;
  let settled = false;

  return {
    render(width: number): string[] {
      const frameWidth = Math.max(0, Math.floor(width));
      if (frameWidth === 0) {
        reviewedToEnd = false;
        reviewAvailable = false;
        return [];
      }
      const contentWidth = modalContentWidth(frameWidth);
      const hintLines = [
        formatStyledKeyHints(theme, [
          ["↑↓", "choose"],
          ["page up/down", "review command"],
        ]),
        formatStyledKeyHints(theme, [
          ["enter", "select"],
          ["esc", "block"],
        ]),
      ].flatMap((line) => wrapTextWithAnsi(line, contentWidth));
      const controlRows = REVIEW_CONTROL_ROWS + hintLines.length;
      const height = tui.terminal?.rows ?? 40;
      if (height < controlRows + 2 || frameWidth < 12) {
        reviewedToEnd = false;
        reviewAvailable = false;
        return renderModalFrame(
          theme,
          frameWidth,
          wrapTextWithAnsi(
            "Resize the terminal to review this command. Esc blocks the call.",
            contentWidth,
          ),
          { title: "Approval Mode", paddingY: 0 },
        );
      }
      reviewAvailable = true;
      const reasonLimit = Math.min(3, height - controlRows - 1);
      const wrappedReason = wrapTextWithAnsi(visibleCommand(reason), contentWidth);
      const reasonLines = wrappedReason.slice(0, reasonLimit);
      if (wrappedReason.length > reasonLimit) {
        reasonLines[reasonLimit - 1] =
          `${truncateToWidth(reasonLines[reasonLimit - 1] ?? "", contentWidth - 1, "")}…`;
      }
      commandRows = Math.max(1, Math.min(COMMAND_ROWS, height - controlRows - reasonLines.length));
      if (lastContentWidth !== contentWidth) {
        commandLines = visibleCommand(reviewText)
          .split("\n")
          .flatMap((line) => wrapTextWithAnsi(line, contentWidth));
        lastContentWidth = contentWidth;
        scrollTop = 0;
        reviewedToEnd = commandLines.length <= commandRows;
        reviewWarning = false;
      }
      const maxScroll = Math.max(0, commandLines.length - commandRows);
      scrollTop = Math.min(scrollTop, maxScroll);
      if (commandLines.length <= commandRows) reviewedToEnd = true;
      const end = Math.min(commandLines.length, scrollTop + commandRows);
      const commandExcerpt = commandLines
        .slice(scrollTop, end)
        .map((line) => theme.fg("text", line));
      const indicator =
        commandLines.length > commandRows
          ? [`${scrollTop + 1}-${end}/${commandLines.length} lines (page up/down to review)`]
          : [];
      const body = [
        theme.fg(
          decision === "reject" ? "error" : "warning",
          `Jev ${decision === "reject" ? "rejected" : "could not confirm"} this command.`,
        ),
        ...reasonLines.map((line) => theme.fg("muted", line)),
        "",
        theme.fg("muted", source ? "Worker request:" : "Command:"),
        ...commandExcerpt,
        ...indicator.map((line) => theme.fg("dim", line)),
        "",
        theme.fg("text", "Approve this call only?"),
        ...selector.render(contentWidth),
        ...(reviewWarning
          ? [theme.fg("warning", "Review all command lines before approval.")]
          : []),
        "",
        ...hintLines,
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
        const maxScroll = Math.max(0, commandLines.length - commandRows);
        scrollTop = Math.max(0, Math.min(maxScroll, scrollTop + direction * commandRows));
        if (reviewAvailable && scrollTop === maxScroll) reviewedToEnd = true;
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
  source?: string,
): Promise<ApprovalChoice | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(
      `Warning: Jev ${decision === "reject" ? "rejected" : "could not confirm"} this command.\n${visibleCommand(reason)}\n\n${source ? `${visibleCommand(source)}\n\n` : ""}${visibleCommand(command)}\n\nApprove this call only?`,
      ["Block", "Approve once"],
      ctx.signal ? { signal: ctx.signal } : {},
    ) as Promise<ApprovalChoice | undefined>;
  }
  return ctx.ui.custom<ApprovalChoice>(
    (tui, theme, keybindings, done) => {
      const handle = createSettleOnce(done, ctx.signal, "Block");
      // A signal already aborted before registration never fires its listener;
      // settle immediately so the dialog cannot hang on a dead context.
      if (ctx.signal?.aborted) handle.settle("Block");
      return {
        ...createApprovalDialog({
          command,
          reason,
          decision,
          ...(source ? { source } : {}),
          tui,
          theme,
          keybindings,
          done: handle.settle,
        }),
        dispose: () => handle.dispose(),
      };
    },
    {
      // Fullscreen viewports consume PageUp/PageDown before extension input
      // unless the overlay is focused; a capturing focused overlay is the only
      // way the dialog receives its page keys.
      overlay: true,
      overlayOptions: { ...PANEL_OVERLAY_OPTIONS, maxHeight: "100%" },
      onHandle: (handle) => handle.focus(),
    },
  );
}
