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
