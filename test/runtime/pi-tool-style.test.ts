import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRailStyles, type RailController } from "../../extensions/tool-style/src/rails.ts";
import { fakeTui } from "../mocks/test-helpers.ts";

const sdk = await import(import.meta.resolve("@earendil-works/pi-coding-agent"));
const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { initTheme, theme } = await import(
  pathToFileURL(resolve(agentDist, "modes/interactive/theme/theme.js")).href
);
const ui = fakeTui({ terminal: { rows: 30, columns: 80 } });
let controller: RailController | undefined;
const renderFailure = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  initTheme("dark", false);
  controller = installRailStyles(
    sdk,
    () => theme,
    () => "#181b24",
    true,
    renderFailure,
  );
});

afterEach(() => {
  controller?.restore();
  controller = undefined;
});

function plainLines(component: { render(width: number): string[] }, width = 40): string[] {
  return component.render(width).map(stripVTControlCharacters);
}

function tool(outputPad: number, definition?: unknown) {
  return new sdk.ToolExecutionComponent(
    "demo",
    "call-1",
    {},
    { outputPad, showImages: false },
    definition,
    ui,
    process.cwd(),
  );
}

function bash(outputPad: number, excluded = false) {
  const component = new sdk.BashExecutionComponent("true", ui, excluded, outputPad);
  component.appendOutput("shell output");
  component.setComplete(0, false);
  return component;
}

function customMessage(outputPad: number) {
  return new sdk.CustomMessageComponent(
    { customType: "test", content: [{ type: "text", text: "message output" }], display: true },
    undefined,
    undefined,
    outputPad,
  );
}

describe("Tool Style with real Pi 1.2.0 renderers", () => {
  it.each([0, 1, 2])("preserves outputPad=%i for tool, shell, and custom output", (outputPad) => {
    const toolComponent = tool(outputPad);
    toolComponent.updateResult({
      content: [{ type: "text", text: "tool output" }],
      isError: false,
    });
    const shellComponent = bash(outputPad);
    const messageComponent = customMessage(outputPad);

    for (const [component, marker] of [
      [toolComponent, "tool output"],
      [shellComponent, "shell output"],
      [messageComponent, "message output"],
    ] as const) {
      const line = plainLines(component).find((value) => value.includes(marker));
      expect(line).toBeDefined();
      expect(line?.indexOf(marker)).toBe(outputPad + 1);
      expect(line?.startsWith("▏")).toBe(true);
      component.setOutputPad(2 - outputPad);
      const updated = plainLines(component).find((value) => value.includes(marker));
      expect(updated?.indexOf(marker)).toBe(3 - outputPad);
    }
    expect(renderFailure).not.toHaveBeenCalled();
  });

  it.each([1, 7, 40])("keeps every rendered line within %i columns", (width) => {
    for (const outputPad of [0, 1, 2]) {
      const toolComponent = tool(outputPad);
      toolComponent.updateResult({
        content: [{ type: "text", text: "tool output" }],
        isError: false,
      });
      for (const component of [toolComponent, bash(outputPad), customMessage(outputPad)]) {
        const lines = component.render(width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(
            visibleWidth(line),
            `${component.constructor.name}: ${JSON.stringify(line)}`,
          ).toBeLessThanOrEqual(width);
        }
      }
    }
    expect(renderFailure).not.toHaveBeenCalled();
  });

  it("preserves the dim !! command header after shell output arrives", () => {
    const component = new sdk.BashExecutionComponent("true", ui, true, 2);
    try {
      const before = component.render(40).find((line: string) => line.includes("$ true"));
      component.appendOutput("shell output");
      component.setComplete(0, false);
      const after = component.render(40).find((line: string) => line.includes("$ true"));

      expect(before).toContain(theme.getFgAnsi("dim"));
      expect(after).toContain(theme.getFgAnsi("dim"));
      expect(stripVTControlCharacters(after ?? "").indexOf("$ true")).toBe(3);
      expect(plainLines(component).some((line) => /^[─]+$/.test(line.trim()))).toBe(false);
      expect(renderFailure).not.toHaveBeenCalled();
    } finally {
      component.setComplete(0, false);
    }
  });

  it("passes recorded duration and padding through native tool render context", () => {
    const renderResult = vi.fn(
      (
        _result: unknown,
        _options: unknown,
        _theme: unknown,
        context: { durationMs: number | undefined; outputPad: number },
      ) =>
        new Text(
          context.durationMs === undefined ? "running" : `Took ${context.durationMs}ms`,
          0,
          0,
        ),
    );
    const component = tool(2, { renderResult });
    const result = { content: [{ type: "text", text: "output" }], isError: false, durationMs: 17 };
    component.updateResult(result, true);
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ durationMs: undefined, outputPad: 2 }),
    );
    component.updateResult(result);
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ durationMs: 17, outputPad: 2 }),
    );
    expect(plainLines(component).join("\n")).toContain("Took 17ms");

    const restored = tool(2, { renderResult });
    restored.updateResult(result);
    expect(plainLines(restored)).toEqual(plainLines(component));
    expect(renderFailure).not.toHaveBeenCalled();
  });
});
