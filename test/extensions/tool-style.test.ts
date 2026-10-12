import {
  BashExecutionComponent,
  CustomMessageComponent,
  Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const surfaceMocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../extensions/tool-style/src/surface.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../extensions/tool-style/src/surface.ts")>()),
  startWalSurfaceMonitor: surfaceMocks.start,
}));

import toolStyleExtension from "../../extensions/tool-style/tool-style.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

const ORIGINAL_RENDERERS = {
  tool: ToolExecutionComponent.prototype.render,
  bash: BashExecutionComponent.prototype.render,
  custom: CustomMessageComponent.prototype.render,
  themeBg: Theme.prototype.bg,
  themeBgAnsi: Theme.prototype.getBgAnsi,
};

type MockRenderedComponent = {
  lines: string[];
  renderedWidth: number;
};

type MockToolExecutionComponent = ToolExecutionComponent &
  MockRenderedComponent & {
    isPartial: boolean;
    result?: { isError?: boolean };
  };

type MockBashExecutionComponent = BashExecutionComponent &
  MockRenderedComponent & {
    status: "running" | "complete" | "error" | "cancelled";
  };

describe("tool-style-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    surfaceMocks.start.mockImplementation((options: { onChange(surface: string): void }) => {
      options.onChange("#181b24");
      return surfaceMocks.stop;
    });
  });

  afterEach(() => {
    ToolExecutionComponent.prototype.render = ORIGINAL_RENDERERS.tool;
    BashExecutionComponent.prototype.render = ORIGINAL_RENDERERS.bash;
    CustomMessageComponent.prototype.render = ORIGINAL_RENDERERS.custom;
    Theme.prototype.bg = ORIGINAL_RENDERERS.themeBg;
    Theme.prototype.getBgAnsi = ORIGINAL_RENDERERS.themeBgAnsi;
  });

  it("registers lifecycle handlers and /toolstyle:toggle", async () => {
    const pi = createMockPi();

    await toolStyleExtension(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "toolstyle:toggle",
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
  });

  it("uses accent, success, and error rails for agent tool states", async () => {
    const { ctx } = await startExtension();
    const component = createToolComponent();

    expect(component.render(20)[1]).toBe("<accent>▏</accent>content");

    component.isPartial = false;
    component.result = { isError: false };
    expect(component.render(20)[1]).toBe("<success>▏</success>content");

    component.result = { isError: true };
    expect(component.render(20)[1]).toBe("<error>▏</error>content");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "▏");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith("success", "▏");
    expect(ctx.ui.theme.fg).toHaveBeenCalledWith("error", "▏");
  });

  it("uses semantic rails and tool backgrounds for direct command states", async () => {
    const { ctx } = await startExtension();
    const component = createBashComponent();

    expect(component.render(20)[1]).toContain("<bashMode>▏</bashMode>content");
    expect(ctx.ui.theme.bg).toHaveBeenLastCalledWith("toolPendingBg", expect.any(String));

    component.status = "complete";
    expect(component.render(20)[1]).toContain("<success>▏</success>content");
    expect(ctx.ui.theme.bg).toHaveBeenLastCalledWith("toolSuccessBg", expect.any(String));

    component.status = "error";
    expect(component.render(20)[1]).toContain("<error>▏</error>content");
    expect(ctx.ui.theme.bg).toHaveBeenLastCalledWith("toolErrorBg", expect.any(String));

    component.status = "cancelled";
    expect(component.render(20)[1]).toContain("<warning>▏</warning>content");
    expect(ctx.ui.theme.bg).toHaveBeenLastCalledWith("toolErrorBg", expect.any(String));
  });

  it("removes direct command borders while preserving the leading spacer and content", async () => {
    await startExtension();
    const component = createBashComponent();
    component.lines = ["", "────", "$ printf test", "output", "────"];

    const lines = component.render(20);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain("$ printf test");
    expect(lines[2]).toContain("output");
    expect(lines.join("\n")).not.toContain("────");
  });

  it("overrides tool backgrounds with the computed pywal surface", async () => {
    await startExtension();
    const theme = new Theme();

    expect(theme.bg("toolPendingBg", "content")).toBe("\u001b[48;2;24;27;36mcontent\u001b[49m");
    expect(theme.bg("customMessageBg", "message")).toBe("\u001b[48;2;24;27;36mmessage\u001b[49m");
    expect(theme.bg("userMessageBg", "user")).toBe(
      "<theme-bg:userMessageBg>user</theme-bg:userMessageBg>",
    );
  });

  it("uses the custom message label color for extension messages", async () => {
    await startExtension();
    const component = new CustomMessageComponent();

    expect(component.render(20)[1]).toBe("<customMessageLabel>▏</customMessageLabel>content");
  });

  it("reserves one column for the rail and keeps the leading spacer unstyled", async () => {
    await startExtension();
    const component = createToolComponent();
    component.lines = ["", "abcdefgh"];

    const lines = component.render(5);

    expect(component.renderedWidth).toBe(4);
    expect(lines).toEqual(["", "<accent>▏</accent>abcd"]);
  });

  it("renders safely in a one-column terminal", async () => {
    await startExtension();
    const component = createToolComponent();
    component.lines = ["", "content"];

    expect(component.render(1)).toEqual(["", "<accent>▏</accent>"]);
    expect(component.renderedWidth).toBe(1);
  });

  it("renders direct shell output safely in a one-column terminal", async () => {
    const { ctx } = await startExtension();
    const component = createBashComponent();
    component.lines = ["", "────", "$ true", "output", "────"];

    expect(component.render(1)).toEqual(["", "<bashMode>▏</bashMode>", "<bashMode>▏</bashMode>"]);
    expect(ctx.ui.theme.bg).toHaveBeenCalledWith("toolPendingBg", "<bashMode>▏</bashMode>");
  });

  it("hides a tool block whose render throws instead of crashing the session", async () => {
    const pi = createMockPi();
    const ctx = createStyledContext();
    ToolExecutionComponent.prototype.render = () => {
      throw new Error("render failed");
    };
    await toolStyleExtension(pi);
    const start = getEventHandler(pi, "session_start");
    await start({ type: "session_start", reason: "startup" }, ctx);

    const component = new ToolExecutionComponent();

    expect(component.render(20)).toEqual([]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Tool style: a tool block failed to render and was hidden",
      "error",
    );
  });

  it("names the tool in the failure notification when known", async () => {
    const pi = createMockPi();
    const ctx = createStyledContext();
    ToolExecutionComponent.prototype.render = () => {
      throw new Error("render failed");
    };
    await toolStyleExtension(pi);
    const start = getEventHandler(pi, "session_start");
    await start({ type: "session_start", reason: "startup" }, ctx);

    const component = new ToolExecutionComponent();
    component.toolName = "web_search";
    component.render(20);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Tool style: the "web_search" tool block failed to render and was hidden',
      "error",
    );
  });

  it("notifies once per broken tool block", async () => {
    const pi = createMockPi();
    const ctx = createStyledContext();
    ToolExecutionComponent.prototype.render = () => {
      throw new Error("render failed");
    };
    await toolStyleExtension(pi);
    const start = getEventHandler(pi, "session_start");
    await start({ type: "session_start", reason: "startup" }, ctx);

    const component = new ToolExecutionComponent();
    component.render(20);
    component.render(20);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("toggles rails without changing component behavior", async () => {
    const { pi, ctx } = await startExtension();
    const toggle = getCommandHandler(pi, "toolstyle:toggle");
    const component = createToolComponent();

    await toggle("", ctx);
    expect(component.render(20)[1]).toBe("content");
    expect(component.renderedWidth).toBe(20);
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(1, "Tool style disabled", "info");

    await toggle("", ctx);
    expect(component.render(20)[1]).toBe("<accent>▏</accent>content");
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(2, "Tool style enabled", "info");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("tool-style-refresh", []);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("tool-style-refresh", undefined);
  });

  it("applies pywal surface changes without reinstalling renderers", async () => {
    let monitorOptions: { onChange(surface: string): void } | undefined;
    surfaceMocks.start.mockImplementation((options: { onChange(surface: string): void }) => {
      monitorOptions = options;
      options.onChange("#101820");
      return surfaceMocks.stop;
    });
    await startExtension();
    const theme = new Theme();
    const originalRenderer = ToolExecutionComponent.prototype.render;

    expect(theme.getBgAnsi("toolPendingBg")).toBe("\u001b[48;2;16;24;32m");
    monitorOptions?.onChange("#202830");

    expect(theme.getBgAnsi("toolPendingBg")).toBe("\u001b[48;2;32;40;48m");
    expect(ToolExecutionComponent.prototype.render).toBe(originalRenderer);
  });

  it("reports invalid pywal data through the UI", async () => {
    surfaceMocks.start.mockImplementation((options: { onError(message: string): void }) => {
      options.onError("invalid colors.json");
      return surfaceMocks.stop;
    });

    const { ctx } = await startExtension();

    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool style: invalid colors.json", "error");
  });

  it("restores every original renderer on session shutdown", async () => {
    const { pi, ctx } = await startExtension();
    const shutdown = getEventHandler(pi, "session_shutdown");

    expect(ToolExecutionComponent.prototype.render).not.toBe(ORIGINAL_RENDERERS.tool);
    expect(BashExecutionComponent.prototype.render).not.toBe(ORIGINAL_RENDERERS.bash);
    expect(CustomMessageComponent.prototype.render).not.toBe(ORIGINAL_RENDERERS.custom);
    expect(Theme.prototype.bg).not.toBe(ORIGINAL_RENDERERS.themeBg);

    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(ToolExecutionComponent.prototype.render).toBe(ORIGINAL_RENDERERS.tool);
    expect(BashExecutionComponent.prototype.render).toBe(ORIGINAL_RENDERERS.bash);
    expect(CustomMessageComponent.prototype.render).toBe(ORIGINAL_RENDERERS.custom);
    expect(Theme.prototype.bg).toBe(ORIGINAL_RENDERERS.themeBg);
    expect(Theme.prototype.getBgAnsi).toBe(ORIGINAL_RENDERERS.themeBgAnsi);
    expect(surfaceMocks.stop).toHaveBeenCalledOnce();
  });

  it("does not stack rails when session_start runs again", async () => {
    const pi = createMockPi();
    const ctx = createStyledContext();
    await toolStyleExtension(pi);
    const start = getEventHandler(pi, "session_start");

    await start({ type: "session_start", reason: "startup" }, ctx);
    await start({ type: "session_start", reason: "reload" }, ctx);

    expect(surfaceMocks.stop).toHaveBeenCalledOnce();
    const component = createToolComponent();
    expect(component.render(20)[1]).toBe("<accent>▏</accent>content");
  });

  it("does nothing when no TUI is available", async () => {
    const pi = createMockPi();
    const ctx = createStyledContext();
    ctx.hasUI = false;
    ctx.mode = "rpc";
    await toolStyleExtension(pi);
    const start = getEventHandler(pi, "session_start");
    const toggle = getCommandHandler(pi, "toolstyle:toggle");

    await start({ type: "session_start", reason: "startup" }, ctx);
    await toggle("", ctx);

    expect(ToolExecutionComponent.prototype.render).toBe(ORIGINAL_RENDERERS.tool);
    expect(surfaceMocks.start).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

async function startExtension() {
  const pi = createMockPi();
  const ctx = createStyledContext();
  await toolStyleExtension(pi);
  const start = getEventHandler(pi, "session_start");
  await start({ type: "session_start", reason: "startup" }, ctx);
  return { pi, ctx };
}

function createToolComponent(): MockToolExecutionComponent {
  return new ToolExecutionComponent() as MockToolExecutionComponent;
}

function createBashComponent(): MockBashExecutionComponent {
  return new BashExecutionComponent() as MockBashExecutionComponent;
}

function createStyledContext() {
  const ctx = createMockCommandContext();
  ctx.ui.theme.fg = vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`);
  return ctx;
}
