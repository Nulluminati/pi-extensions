import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bashAllowExtension from "../../extensions/bash-allow/bash-allow.ts";
import { createMockContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

describe("bash-allow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PI_BASH_ALLOW", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function setup(flag?: string, settings = {}) {
    const pi = createMockPi();
    pi.getSettings.mockReturnValue(settings);
    pi.events.on.mockReturnValue(vi.fn());
    const ctx = createMockContext();
    await bashAllowExtension(pi);
    // Pi assigns CLI flags after factories run.
    pi.getFlag.mockReturnValue(flag);
    const start = () => getEventHandler(pi, "session_start")({ type: "session_start" }, ctx);
    await start();
    const call = (command: unknown, toolName = "bash", extra: Record<string, unknown> = {}) =>
      getEventHandler(pi, "tool_call")(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName,
          input: { command, ...extra },
        },
        ctx,
      );
    return { pi, ctx, start, call };
  }

  it("publishes the effective list for workers and resets it on session_start", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "ls:*");
    const { pi, start } = await setup("pwd:*");
    const listener = pi.events.on.mock.calls.find(([name]) => name === "bash-allow:request")?.[1];
    if (!listener) throw new Error("bash-allow request listener not registered");
    const reply = vi.fn();
    listener({ reply });
    expect(reply).toHaveBeenLastCalledWith("pwd:*");
    pi.getFlag.mockReturnValue("");
    await start();
    listener({ reply });
    expect(reply).toHaveBeenLastCalledWith("");
    vi.stubEnv("PI_BASH_ALLOW", undefined);
    pi.getFlag.mockReturnValue(undefined);
    await start();
    listener({ reply });
    expect(reply).toHaveBeenLastCalledWith(undefined);
    expect(() => listener(null)).not.toThrow();
    expect(() => listener({ reply: "not a function" })).not.toThrow();
  });
  it("removes the worker policy listener on shutdown", async () => {
    const { pi, ctx } = await setup();
    const stopListening = pi.events.on.mock.results[0].value;
    await getEventHandler(pi, "session_shutdown")(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    expect(stopListening).toHaveBeenCalledTimes(1);
  });
  it("registers the string flag", async () => {
    const { pi } = await setup();
    expect(pi.registerFlag).toHaveBeenCalledWith("bash-allow", {
      type: "string",
      description: "Comma-separated bash command allow list; every other shell call is blocked",
    });
  });
  it("reads the environment when the flag is unset", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "pwd:*");
    const { call } = await setup();
    expect(await call("pwd")).toBeUndefined();
    expect(await call("ls")).toEqual({
      block: true,
      reason: expect.stringContaining("Allowed: pwd:*"),
    });
  });
  it("lets the flag override the environment", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "a:*");
    const { call } = await setup("b:*");
    expect(await call("b")).toBeUndefined();
    expect(await call("a")).toEqual({ block: true, reason: expect.stringContaining("b:*") });
  });
  it("leaves shell calls unrestricted without a list", async () => {
    const { call } = await setup();
    for (const tool of ["bash", "background", "monitor"])
      expect(await call("anything > x", tool)).toBeUndefined();
  });
  it.each(["bash", "background", "monitor"])("gates %s by its command input", async (tool) => {
    const { call } = await setup("pwd:*");
    expect(await call("pwd", tool)).toBeUndefined();
    expect(await call("ls", tool)).toEqual({
      block: true,
      reason: expect.stringContaining("Allowed: pwd:*"),
    });
  });
  it.each(["", "  ", undefined, 42])("blocks empty or invalid commands: %j", async (command) => {
    const { call } = await setup("pwd:*");
    expect(await call(command)).toEqual({ block: true, reason: "Command is empty." });
  });
  it.each([
    { GH_BROWSER: "touch /tmp/pwned" },
    { PATH: "/untrusted/bin" },
    { LD_PRELOAD: "/untrusted/library.so" },
  ])("blocks background environment overrides: %j", async (env) => {
    const { call } = await setup("gh pr view:*");
    expect(await call("gh pr view 7 --web", "background", { env })).toEqual({
      block: true,
      reason: expect.stringContaining("environment overrides"),
    });
  });
  it.each(["/outside", ".", ""])("blocks background directory overrides: %j", async (cwd) => {
    const { call } = await setup("pwd:*");
    expect(await call("pwd", "background", { cwd })).toEqual({
      block: true,
      reason: expect.stringContaining("working directory overrides"),
    });
  });
  it("allows an empty background environment without a directory override", async () => {
    const { call } = await setup("pwd:*");
    expect(await call("pwd", "background", { env: {} })).toBeUndefined();
  });
  it("does not restrict background overrides without a list", async () => {
    const { call } = await setup();
    expect(
      await call("pwd", "background", { env: { PATH: "/custom" }, cwd: "/outside" }),
    ).toBeUndefined();
  });
  it.each(["/usr/bin/fish", "/bin/zsh", "/bin/pwsh"])(
    "fails closed for unsupported shell %s",
    async (shellPath) => {
      const { ctx, call } = await setup("echo:*", { shellPath });
      for (const tool of ["bash", "background", "monitor"]) {
        expect(await call("echo allowed", tool)).toEqual({
          block: true,
          reason: expect.stringContaining(`Unsupported shellPath: ${shellPath}`),
        });
      }
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported shellPath:"),
        "error",
      );
    },
  );
  it.each([undefined, "", "/bin/bash", "/bin/sh", "bash", "C:\\Program Files\\Git\\bin\\bash.exe"])(
    "allows a supported shell setting %j",
    async (shellPath) => {
      const { call } = await setup("pwd:*", shellPath === undefined ? {} : { shellPath });
      expect(await call("pwd")).toBeUndefined();
    },
  );
  it("does not restrict an unsupported shell without a list", async () => {
    const { ctx, call } = await setup(undefined, { shellPath: "/usr/bin/fish" });
    expect(await call("echo anything")).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
  it("keeps an unsupported startup shell blocked until session_start resets it", async () => {
    const { pi, start, call } = await setup("pwd:*", { shellPath: "/usr/bin/fish" });
    pi.getSettings.mockReturnValue({ shellPath: "/bin/bash" });
    expect(await call("pwd")).toEqual({
      block: true,
      reason: expect.stringContaining("Unsupported shellPath:"),
    });
    await start();
    expect(await call("pwd")).toBeUndefined();
  });
  it("clears an unsupported shell error when the list is removed", async () => {
    const { pi, start, call } = await setup("pwd:*", { shellPath: "/usr/bin/fish" });
    pi.getFlag.mockReturnValue(undefined);
    await start();
    expect(await call("anything")).toBeUndefined();
  });
  it("checks shell settings again before execution", async () => {
    const { pi, call } = await setup("pwd:*");
    pi.getSettings.mockReturnValue({ shellPath: "/usr/bin/fish" });
    expect(await call("pwd")).toEqual({
      block: true,
      reason: expect.stringContaining("Unsupported shellPath:"),
    });
    pi.getSettings.mockReturnValue({ shellPath: "/bin/bash" });
    expect(await call("pwd")).toBeUndefined();
  });
  it("does not notify without UI for an unsupported shell", async () => {
    const { pi, ctx, start, call } = await setup("pwd:*");
    ctx.hasUI = false;
    pi.getSettings.mockReturnValue({ shellPath: "/usr/bin/fish" });
    await start();
    expect(await call("pwd")).toEqual({
      block: true,
      reason: expect.stringContaining("Unsupported shellPath:"),
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
  it("ignores other tools", async () => {
    const { call } = await setup("pwd:*");
    expect(await call("rm -rf /", "read")).toBeUndefined();
  });
  it.each(["a,,b", "", "a*b"])("fails closed for malformed list %j", async (list) => {
    const { ctx, call } = await setup(list);
    for (const tool of ["bash", "background", "monitor"]) {
      expect(await call("a", tool)).toEqual({
        block: true,
        reason: expect.stringContaining("bash-allow could not read its list:"),
      });
    }
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bash-allow could not read its list:"),
      "error",
    );
  });
  it("fails closed for an empty environment value", async () => {
    vi.stubEnv("PI_BASH_ALLOW", "");
    const { call } = await setup();
    expect(await call("pwd")).toEqual({
      block: true,
      reason: expect.stringContaining("could not read"),
    });
  });
  it("resets rules and errors on session_start without UI", async () => {
    const { pi, ctx, start, call } = await setup("pwd:*");
    ctx.hasUI = false;
    pi.getFlag.mockReturnValue("bad*rule");
    await start();
    expect(await call("pwd")).toEqual({
      block: true,
      reason: expect.stringContaining("could not read"),
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    pi.getFlag.mockReturnValue(undefined);
    await start();
    expect(await call("ls")).toBeUndefined();
  });
});
