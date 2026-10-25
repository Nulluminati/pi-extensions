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

  async function setup(flag?: string) {
    const pi = createMockPi();
    const ctx = createMockContext();
    await bashAllowExtension(pi);
    // Pi assigns CLI flags after factories run.
    pi.getFlag.mockReturnValue(flag);
    const start = () => getEventHandler(pi, "session_start")({ type: "session_start" }, ctx);
    await start();
    const call = (command: unknown, toolName = "bash") =>
      getEventHandler(pi, "tool_call")(
        {
          type: "tool_call",
          toolCallId: "call-1",
          toolName,
          input: { command },
        },
        ctx,
      );
    return { pi, ctx, start, call };
  }

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
