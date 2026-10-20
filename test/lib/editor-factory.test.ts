import type { EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
  removeEditorFactoryLayer,
} from "../../lib/editor-factory.ts";

const BASE_LAYER = "base-decoration";
const OUTER_LAYER = "outer-behavior";

interface LayeredEditor {
  layers: string[];
}

// Composition never reads the factory arguments or calls editor methods, so
// plain objects stand in for the TUI, theme, keybindings and editors.
const FACTORY_ARGS = [{}, {}, {}] as unknown as Parameters<EditorFactory>;

function asEditor(editor: LayeredEditor): EditorComponent {
  return editor as unknown as EditorComponent;
}

function renderLayers(factory: EditorFactory): string[] {
  return (factory(...FACTORY_ARGS) as unknown as LayeredEditor).layers;
}

function baseFactory(label: string): EditorFactory {
  return () => asEditor({ layers: [label] });
}

function layer(current: EditorFactory | undefined, id: string, priority: number): EditorFactory {
  return installEditorFactoryLayer(current, id, priority, (parent, tui, theme, keybindings) => {
    const editor = (parent?.(tui, theme, keybindings) ?? {
      layers: [],
    }) as unknown as LayeredEditor;
    editor.layers.push(id);
    return asEditor(editor);
  });
}

describe("editor factory composition", () => {
  it("orders behavior layers outside visual layers regardless of install order", () => {
    const base = baseFactory("original");
    const outerFirst = layer(layer(base, OUTER_LAYER, 100), BASE_LAYER, 0);
    const baseFirst = layer(layer(base, BASE_LAYER, 0), OUTER_LAYER, 100);

    expect(renderLayers(outerFirst)).toEqual(["original", BASE_LAYER, OUTER_LAYER]);
    expect(renderLayers(baseFirst)).toEqual(["original", BASE_LAYER, OUTER_LAYER]);
  });

  it("does not install the same layer twice", () => {
    const first = layer(baseFactory("original"), BASE_LAYER, 0);
    const second = layer(first, BASE_LAYER, 0);

    expect(second).toBe(first);
    expect(renderLayers(second)).toEqual(["original", BASE_LAYER]);
  });

  it("removes an inner layer while preserving and rebasing outer layers", () => {
    const composed = layer(layer(baseFactory("original"), BASE_LAYER, 0), OUTER_LAYER, 100);

    const remaining = removeEditorFactoryLayer(composed, BASE_LAYER);

    expect(hasEditorFactoryLayer(remaining, BASE_LAYER)).toBe(false);
    expect(hasEditorFactoryLayer(remaining, OUTER_LAYER)).toBe(true);
    expect(renderLayers(remaining as EditorFactory)).toEqual(["original", OUTER_LAYER]);
  });

  it("returns the original factory when the requested layer is absent", () => {
    const original = baseFactory("original");

    expect(removeEditorFactoryLayer(original, "missing")).toBe(original);
  });

  it("supports an absent base factory", () => {
    const instantiate = vi.fn(() => asEditor({ layers: [BASE_LAYER] }));
    const composed = installEditorFactoryLayer(undefined, BASE_LAYER, 0, instantiate);

    expect(composed(...FACTORY_ARGS)).toEqual({ layers: [BASE_LAYER] });
    expect(instantiate).toHaveBeenCalledWith(undefined, {}, {}, {});
    expect(removeEditorFactoryLayer(composed, BASE_LAYER)).toBeUndefined();
  });
});
