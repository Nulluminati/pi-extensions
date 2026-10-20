import type { Message } from "@earendil-works/pi-ai";
import { vi } from "vitest";

/**
 * Extract a registered event handler by event type from a mock Pi instance.
 *
 * Accepts any mock object with a `on.mock.calls` array. The structural type is
 * intentionally loose (uses `any` for the calls) so it works with
 * `DeepMocked<ExtensionAPI>` and any narrower mock.
 */
export function getEventHandler(
  // biome-ignore lint/suspicious/noExplicitAny: loose mock type, see comment
  mockPi: { on: { mock: { calls: any[] } } },
  eventType: string,
): (...args: unknown[]) => unknown {
  const calls = mockPi.on.mock.calls;
  for (const call of calls) {
    if (call[0] === eventType) return call[1];
  }
  throw new Error(`Event handler for ${eventType} not found`);
}

/**
 * Extract a registered command handler by command name from a mock Pi instance.
 *
 * Accepts any mock object with a `registerCommand.mock.calls` array. The
 * structural type is intentionally loose (uses `any` for the calls) so it
 * works with `DeepMocked<ExtensionAPI>` and any narrower mock.
 */
export function getCommandHandler(
  // biome-ignore lint/suspicious/noExplicitAny: loose mock type, see comment
  mockPi: { registerCommand: { mock: { calls: any[] } } },
  commandName: string,
): (...args: unknown[]) => unknown {
  const calls = mockPi.registerCommand.mock.calls;
  for (const call of calls) {
    if (call[0] === commandName) return call[1].handler;
  }
  throw new Error(`Command handler for ${commandName} not found`);
}

/**
 * Drive the framed confirmModal through `mockCtx.ui.custom`: presses Enter
 * (resolves `true`) when `confirmed`, otherwise Esc (resolves `false`).
 * Assign the result to `mockCtx.ui.custom` before invoking the handler.
 */
export function makeConfirmCustom(mockCtx: { ui: { theme: unknown } }, confirmed: boolean) {
  return vi.fn((factory: unknown) => {
    return new Promise((resolve) => {
      const component = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: boolean) => void,
        ) => { handleInput(data: string): void }
      )(
        { requestRender: () => {} },
        mockCtx.ui.theme,
        {
          matches: (data: string, keybinding: string) =>
            ({
              "tui.select.confirm": ["\r", "\n"],
              "tui.select.cancel": ["\u001b", "\u0003"],
            })[keybinding]?.includes(data) ?? false,
        },
        resolve,
      );
      component.handleInput(confirmed ? "\r" : "\u001b");
    });
  });
}

/** Text of a message's first content block, for asserting on prompts sent to a model. */
export function firstContentText(message: Message | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === "string") return content;
  const block = content?.[0];
  return block && "text" in block ? block.text : undefined;
}
