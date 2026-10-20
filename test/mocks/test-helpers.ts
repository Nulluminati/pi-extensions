import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionUIContext,
  KeybindingsManager,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type Mock, vi } from "vitest";
import { mockFn } from "./mock-types.ts";

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
  return mockFn<ExtensionUIContext["custom"]>((factory: unknown) => {
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

/**
 * A stand-in TUI for component factories under test. Components in unit tests
 * only call `requestRender` (and sometimes read `terminal.rows`), so the fake
 * carries those members and is asserted as the SDK type in this one place.
 */
export function fakeTui<M extends Record<string, unknown>>(
  members: M = {} as M,
): TUI & { requestRender: Mock<() => void> } & M {
  return { requestRender: vi.fn(), ...members } as unknown as TUI & {
    requestRender: Mock<() => void>;
  } & M;
}

/**
 * Text of a result's or message's content block; throws when the block is not
 * text. String content counts as one text block.
 */
export function contentText(
  result: { content: string | ReadonlyArray<TextContent | ImageContent> } | undefined,
  index = 0,
): string {
  const content = result?.content;
  if (typeof content === "string" && index === 0) return content;
  const block = typeof content === "string" ? undefined : content?.[index];
  if (block?.type !== "text") throw new Error(`content[${index}] is not a text block`);
  return block.text;
}

/**
 * Session entries for `sessionManager.getBranch` and friends. Fixtures carry
 * only the fields the extension under test reads, so they are asserted as
 * full SDK entries in this one place.
 */
export function sessionEntries(entries: readonly unknown[]): SessionEntry[] {
  return entries as SessionEntry[];
}

/**
 * A stand-in Theme with the given members, for components rendered with a
 * plain or recording theme. Theme is a class with private fields, so the fake
 * is asserted as the SDK type in this one place.
 */
export function fakeTheme<M extends Record<string, unknown>>(members: M): Theme & M {
  return members as unknown as Theme & M;
}

/** Keybindings that answer `matches` with the given function. */
export function fakeKeybindings(
  matches: (data: string, keybinding: string) => boolean = () => false,
): KeybindingsManager {
  return { matches } as unknown as KeybindingsManager;
}

/**
 * A fixture that carries only the fields the code under test reads, asserted
 * as the SDK type the mock returns. Use it for partial SDK objects such as
 * system prompt options, tool infos or model replies.
 */
export function fixtureAs<T>(value: unknown): T {
  return value as T;
}
