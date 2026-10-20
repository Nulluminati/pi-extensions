import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionNameExtension from "../../extensions/session-name/session-name.ts";
import { createMockContext, createMockModel } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { fixtureAs, sessionEntries } from "../mocks/test-helpers.ts";

const TEMP = "Pi · project · 12345678";
const ENTRY = "session-name:state";
const fixtures: Array<{ stop(): Promise<void> }> = [];
const complete = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("PI_WORKER", "0");
  vi.stubEnv("PI_SMALL_MODEL", "title-provider/title-model");
  vi.stubEnv("PI_SMALL_MODEL_THINKING", "low");
  complete.mockResolvedValue({
    content: [{ type: "text", text: "Fix authentication timeout" }],
    stopReason: "stop",
  });
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function marker(phase: string, name = TEMP, sessionId = "12345678-abcdef") {
  return { type: "custom", customType: ENTRY, data: { phase, name, sessionId } };
}
function user(content: unknown = "Fix expired login tokens") {
  return { type: "message", message: { role: "user", content, timestamp: Date.now() } };
}
async function setup(options: { name?: string; branch?: unknown[] } = {}) {
  const pi = createMockPi(),
    ctx = createMockContext();
  ctx.cwd = "/repo/project";
  ctx.sessionManager.getSessionId.mockReturnValue("12345678-abcdef");
  const branch = [...(options.branch ?? [])];
  let name = options.name;
  pi.getSessionName.mockImplementation(() => name);
  pi.setSessionName.mockImplementation((value) => {
    name = value;
    branch.push({ type: "session_info", name: value });
  });
  pi.appendEntry.mockImplementation((customType, data) =>
    branch.push({ type: "custom", customType, data }),
  );
  ctx.sessionManager.getBranch.mockImplementation(() => sessionEntries(branch));
  const small = createMockModel({ id: "title-model", provider: "title-provider", reasoning: true });
  ctx.modelRegistry.find.mockImplementation((provider, id) =>
    provider === small.provider && id === small.id ? small : undefined,
  );
  ctx.modelRegistry.streamSimple.mockImplementation((model, payload, options) =>
    fixtureAs({ result: () => complete(model, payload, options) }),
  );
  ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
    ok: true,
    apiKey: "title-key",
    headers: { "X-Title": "yes" },
    env: { TITLE_TOKEN: "token" },
  });
  await sessionNameExtension(pi);
  const fire = async (event: string, data: unknown = { type: event }) => {
    const handler = pi.on.mock.calls.find(([registered]) => registered === event)?.[1];
    if (!handler) throw new Error(`Missing ${event} handler`);
    return handler(data, ctx);
  };
  const start = () => fire("session_start", { type: "session_start", reason: "startup" });
  const stop = async () => {
    await pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1](
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
  };
  const message = async (content: unknown = "Fix expired login tokens", role = "user") => {
    const message = { role, content, timestamp: Date.now() };
    branch.push({ type: "message", message });
    await fire("message_end", { type: "message_end", message });
  };
  const rename = async (value: string | undefined) => {
    name = value;
    await fire("session_info_changed", { type: "session_info_changed", name: value });
  };
  const fixture = { pi, ctx, small, branch, start, stop, fire, message, rename, name: () => name };
  fixtures.push(fixture);
  return fixture;
}

async function generated(fixture: Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(() =>
    expect(fixture.pi.setSessionName).toHaveBeenCalledWith("Fix authentication timeout"),
  );
}

describe("automatic Pi session names", () => {
  it("loads one async entrypoint without names, calls, or timers until startup", async () => {
    const fixture = await setup();
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.pi.registerFlag).toHaveBeenCalledWith(
      "session-name-disable",
      expect.objectContaining({ type: "boolean", default: false }),
    );
    const files = await readdir(resolve(import.meta.dirname, "../../extensions/session-name"));
    expect(files.filter((file) => file.endsWith(".ts"))).toEqual(["session-name.ts"]);
  });

  it("preserves a name when its ownership marker contains a malformed phase", async () => {
    const saved = marker("temporary");
    const fixture = await setup({
      name: TEMP,
      branch: [{ ...saved, data: { ...saved.data, phase: { toString: 0 } } }],
    });
    await fixture.start();
    await fixture.message();
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("bounds temporary project names without splitting a Unicode code point", async () => {
    const fixture = await setup();
    fixture.ctx.cwd = `/repo/${"a".repeat(31)}😀long`;
    await fixture.start();
    expect(fixture.name()).toBe(`Pi · ${"a".repeat(31)}😀 · 12345678`);
  });

  it("sets and persists a temporary project name before the first message", async () => {
    const fixture = await setup();
    await fixture.start();
    expect(fixture.name()).toBe(TEMP);
    expect(fixture.pi.appendEntry).toHaveBeenCalledWith(ENTRY, {
      phase: "temporary",
      name: TEMP,
      sessionId: "12345678-abcdef",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the configured small model once after the first user message", async () => {
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await generated(fixture);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      fixture.small,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Fix expired login tokens" }],
          }),
        ],
      }),
      expect.objectContaining({
        apiKey: "title-key",
        headers: { "X-Title": "yes" },
        env: { TITLE_TOKEN: "token" },
        reasoning: "low",
        signal: expect.any(AbortSignal),
        maxTokens: 1024,
        cacheRetention: "none",
      }),
    );
    expect(fixture.pi.appendEntry).toHaveBeenCalledWith(ENTRY, {
      phase: "generated",
      name: "Fix authentication timeout",
      sessionId: "12345678-abcdef",
    });
    await fixture.message("another topic");
    await fixture.message("assistant response", "assistant");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fixture.pi.sendMessage).not.toHaveBeenCalled();
    expect(fixture.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(fixture.pi.events.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves room for a title after the model's reasoning tokens", async () => {
    complete.mockImplementation((_model, _payload, options) =>
      Promise.resolve(
        options.maxTokens > 256
          ? {
              content: [
                { type: "thinking", thinking: "Evaluate the topic" },
                { type: "text", text: "Fix authentication timeout" },
              ],
              stopReason: "stop",
            }
          : {
              content: [{ type: "thinking", thinking: "Evaluate the topic" }],
              stopReason: "length",
            },
      ),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message("hello how are you");
    await generated(fixture);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("retains the smaller output limit when thinking is disabled", async () => {
    vi.stubEnv("PI_SMALL_MODEL_THINKING", "off");
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await generated(fixture);
    expect(complete).toHaveBeenCalledWith(
      fixture.small,
      expect.anything(),
      expect.objectContaining({ maxTokens: 256 }),
    );
    expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("retains the smaller output limit for models without reasoning support", async () => {
    const fixture = await setup();
    fixture.small.reasoning = false;
    await fixture.start();
    await fixture.message();
    await generated(fixture);
    expect(complete).toHaveBeenCalledWith(
      fixture.small,
      expect.anything(),
      expect.objectContaining({ maxTokens: 256 }),
    );
    expect(complete.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("does not wait for generation or start duplicate calls during a main turn", async () => {
    let finish: ((value: unknown) => void) | undefined;
    complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(fixture.name()).toBe(TEMP);
    await fixture.message("follow up");
    expect(complete).toHaveBeenCalledTimes(1);
    finish?.({
      content: [{ type: "text", text: "Fix authentication timeout" }],
      stopReason: "stop",
    });
    await generated(fixture);
  });

  it.each(["Manual topic", TEMP])(
    "preserves an existing name without assuming ownership: %s",
    async (name) => {
      const fixture = await setup({ name });
      await fixture.start();
      await fixture.message();
      expect(fixture.name()).toBe(name);
      expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
      expect(fixture.pi.appendEntry).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("restores a temporary name and uses the first persisted user message", async () => {
    const fixture = await setup({
      name: TEMP,
      branch: [marker("temporary"), user("First persisted topic"), user("Later topic")],
    });
    await fixture.start();
    await generated(fixture);
    expect(complete.mock.calls[0][1].messages[0].content).toEqual([
      { type: "text", text: "First persisted topic" },
    ]);
    expect(fixture.pi.setSessionName).toHaveBeenCalledTimes(1);
  });

  it.each(["generated", "failed"])("does not retry a persisted %s attempt", async (phase) => {
    const fixture = await setup({ name: TEMP, branch: [marker(phase), user()] });
    await fixture.start();
    await fixture.message();
    expect(complete).not.toHaveBeenCalled();
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
  });

  it("does not adopt a parent session's temporary-name marker after a fork", async () => {
    const fixture = await setup({
      name: TEMP,
      branch: [marker("temporary", TEMP, "parent-session"), user()],
    });
    await fixture.start();
    await fixture.message();
    expect(complete).not.toHaveBeenCalled();
  });

  it("backs up an unnamed existing session from its first message", async () => {
    const fixture = await setup({
      branch: [user("Existing first request"), user("Existing second request")],
    });
    await fixture.start();
    await generated(fixture);
    expect(complete.mock.calls[0][1].messages[0].content).toEqual([
      { type: "text", text: "Existing first request" },
    ]);
  });

  it("cancels a pending title when the user renames the session", async () => {
    let finish: ((value: unknown) => void) | undefined;
    complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await fixture.rename("Keep this manual name");
    expect(complete.mock.calls[0][2].signal?.aborted).toBe(true);
    finish?.({ content: [{ type: "text", text: "Stale title" }], stopReason: "stop" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.name()).toBe("Keep this manual name");
    expect(fixture.pi.setSessionName).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("aborts shutdown and rejects late output when a replacement session starts", async () => {
    let finish: ((value: unknown) => void) | undefined;
    complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await fixture.stop();
    expect(complete.mock.calls[0][2].signal?.aborted).toBe(true);
    fixture.ctx.sessionManager.getSessionId.mockReturnValue("87654321-replacement");
    fixture.branch.length = 0;
    await fixture.rename(undefined);
    await fixture.start();
    finish?.({ content: [{ type: "text", text: "Stale title" }], stopReason: "stop" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.name()).toBe("Pi · project · 87654321");
    await fixture.message("Replacement topic");
    await generated(fixture);
    expect(fixture.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("rejects late output if the session identity changes without a matching context", async () => {
    let finish: ((value: unknown) => void) | undefined;
    complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(finish).toBeDefined());
    fixture.ctx.sessionManager.getSessionId.mockReturnValue("another-session");
    finish?.({ content: [{ type: "text", text: "Wrong session title" }], stopReason: "stop" });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.pi.setSessionName).toHaveBeenCalledTimes(1);
  });

  it("reports a missing configured model once without falling back or retrying", async () => {
    const fixture = await setup();
    fixture.ctx.modelRegistry.find.mockReturnValue(undefined);
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Global small model not found"),
        "error",
      ),
    );
    await fixture.message("try again");
    expect(fixture.name()).toBe(TEMP);
    expect(complete).not.toHaveBeenCalled();
    expect(fixture.pi.appendEntry).toHaveBeenCalledWith(ENTRY, {
      phase: "failed",
      name: TEMP,
      sessionId: "12345678-abcdef",
    });
    expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("reports a provider error rather than using error content as a name", async () => {
    complete.mockResolvedValue({
      content: [{ type: "text", text: "Error output" }],
      stopReason: "error",
      errorMessage: "provider rejected",
    });
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("provider rejected"),
        "error",
      ),
    );
    expect(fixture.name()).toBe(TEMP);
  });

  it("times out a stalled provider and clears the timer", async () => {
    complete.mockImplementation(
      (_model, _context, options) =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
        "error",
      ),
    );
    expect(fixture.name()).toBe(TEMP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the prompt and removes title controls, quotes, and extra lines", async () => {
    complete.mockResolvedValue({
      content: [{ type: "text", text: '"Fix\u001b authentication\u200b timeout"\nExtra line' }],
      stopReason: "stop",
    });
    const fixture = await setup();
    await fixture.start();
    await fixture.message("x".repeat(100_000));
    await generated(fixture);
    expect(complete.mock.calls[0][1].messages[0].content[0].text.length).toBeLessThanOrEqual(8_000);
    expect(fixture.name()).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("caps generated Unicode names without splitting surrogate pairs", async () => {
    complete.mockResolvedValue({
      content: [{ type: "text", text: "😀".repeat(100) }],
      stopReason: "stop",
    });
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() => expect(fixture.pi.setSessionName).toHaveBeenCalledTimes(2));
    expect([...(fixture.name() ?? "")]).toHaveLength(60);
  });

  it("rejects an empty title and keeps the temporary name", async () => {
    complete.mockResolvedValue({
      content: [{ type: "thinking", thinking: "private" }],
      stopReason: "stop",
    });
    const fixture = await setup();
    await fixture.start();
    await fixture.message();
    await vi.waitFor(() =>
      expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("empty title"),
        "error",
      ),
    );
    expect(fixture.name()).toBe(TEMP);
  });

  it.each(["rpc", "json", "print"] as const)("does nothing in %s mode", async (mode) => {
    const fixture = await setup();
    fixture.ctx.mode = mode;
    await fixture.start();
    await fixture.message();
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does nothing without UI or with the disable flag", async () => {
    const fixture = await setup();
    fixture.ctx.hasUI = false;
    await fixture.start();
    fixture.ctx.hasUI = true;
    fixture.pi.getFlag.mockReturnValue(true);
    await fixture.start();
    await fixture.message();
    expect(fixture.pi.setSessionName).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not install automatic naming in a worker", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const fixture = await setup();
    expect(fixture.pi.on).not.toHaveBeenCalled();
    expect(fixture.pi.registerFlag).not.toHaveBeenCalled();
  });
});
