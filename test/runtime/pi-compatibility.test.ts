import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolishedEditor } from "../../extensions/status-bar/src/editor.ts";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};

function editor() {
  return new PolishedEditor(
    { requestRender() {}, terminal: { rows: 30, columns: 80 } },
    theme,
    { matches: () => false },
    theme,
    () => "test/model",
    () => "",
    () => "off",
    () => ({ on: false, capable: false }),
    () => undefined,
    () => undefined,
  );
}

function click(x: number, y: number, width = 40, height = 5) {
  return {
    type: "click" as const,
    button: "left" as const,
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("unmocked Pi compatibility", () => {
  it.each(["pi-coding-agent", "pi-ai", "pi-tui"])(
    "uses at least the 1.1.0 %s development package within 1.x",
    (name) => {
      const entry = fileURLToPath(import.meta.resolve(`@earendil-works/${name}`));
      const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8"));
      expect(manifest.version).toMatch(/^1\./);
      const [, minor] = manifest.version.split(".").map(Number);
      expect(minor).toBeGreaterThanOrEqual(1);
    },
  );

  it("loads every extension with the real Pi loader", async () => {
    vi.stubEnv("PI_WORKER", "");
    const { readdirSync } = await import("node:fs");
    const { loadExtensions } = await import(
      pathToFileURL(resolve(dirname(codingAgentEntry), "core/extensions/loader.js")).href
    );
    const paths = readdirSync(resolve("extensions")).map((name) =>
      resolve("extensions", name, `${name}.ts`),
    );
    const result = await loadExtensions(paths, process.cwd());
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(paths.length);
  });

  it("maps a single-line framed editor click to the first character", () => {
    const component = editor();
    component.setText("abcdef");
    component.render(40);
    component.handleMouse(click(3, 2));
    expect(component.getCursor?.()).toEqual({ line: 0, col: 0 });
  });

  it("maps multiline editor clicks without a row or column offset", () => {
    const component = editor();
    component.setText("abcdef\nghijkl");
    component.render(40);
    component.handleMouse(click(5, 2, 40, 6));
    expect(component.getCursor?.()).toEqual({ line: 0, col: 2 });
    component.handleMouse(click(4, 3, 40, 6));
    expect(component.getCursor?.()).toEqual({ line: 1, col: 1 });
  });

  it("maps clicks on wrapped text to the native logical column", () => {
    const component = editor();
    component.setText("abcdefghijklmnop");
    component.render(16);
    component.handleMouse(click(5, 3, 16, 6));
    // The base editor reserves one cursor column, so a wrapped row holds nine characters.
    expect(component.getCursor?.()).toEqual({ line: 0, col: 11 });
  });

  it("keeps wide grapheme boundaries when mapping clicks", () => {
    const component = editor();
    component.setText("a👩‍💻b");
    component.render(40);
    component.handleMouse(click(6, 2));
    expect(component.getCursor?.()).toEqual({ line: 0, col: 6 });
  });

  it("maps autocomplete clicks below the frame without a horizontal inset", async () => {
    const component = editor();
    component.setAutocompleteProvider?.({
      getSuggestions: async () => ({
        items: [
          { value: "hello", label: "hello" },
          { value: "help", label: "help" },
        ],
        prefix: "he",
      }),
      applyCompletion: (
        _lines: string[],
        _line: number,
        _col: number,
        item: { value: string },
      ) => ({
        lines: [item.value],
        cursorLine: 0,
        cursorCol: item.value.length,
      }),
    });
    component.setText("he");
    component.handleInput("\t");
    await vi.waitFor(() => expect(component.render(40).join("\n")).toContain("hello"));
    const lines = component.render(40);
    const row = lines.findIndex((line) => line.includes("help"));
    expect(row).toBeGreaterThan(4);
    component.handleMouse(click(0, row, 40, lines.length));
    expect(component.getText()).toBe("help");
  });

  it("leaves narrow unframed editor clicks unchanged", () => {
    const component = editor();
    component.setText("ab");
    component.render(3);
    component.handleMouse(click(0, 1, 3, 3));
    expect(component.getCursor?.()).toEqual({ line: 0, col: 0 });
  });
});
