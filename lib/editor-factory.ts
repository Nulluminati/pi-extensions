/**
 * Composes independently owned editor factory layers in a stable order.
 * Higher-priority behavior layers wrap lower-priority visual layers.
 */

import type { EditorFactory } from "./pi-types.ts";

export type { EditorFactory };

export type EditorLayerInstantiate = (
  parent: EditorFactory | undefined,
  ...args: Parameters<EditorFactory>
) => ReturnType<EditorFactory>;

interface EditorFactoryLayer {
  id: string;
  priority: number;
  parent: EditorFactory | undefined;
  instantiate: EditorLayerInstantiate;
}

const EDITOR_FACTORY_LAYER = Symbol.for("pi-extensions.editor-factory-layer");

type LayeredEditorFactory = EditorFactory & {
  [EDITOR_FACTORY_LAYER]?: EditorFactoryLayer;
};

function layerMetadata(factory: EditorFactory | undefined): EditorFactoryLayer | undefined {
  return (factory as LayeredEditorFactory | undefined)?.[EDITOR_FACTORY_LAYER];
}

function createLayerFactory(
  parent: EditorFactory | undefined,
  id: string,
  priority: number,
  instantiate: EditorLayerInstantiate,
): EditorFactory {
  const factory: LayeredEditorFactory = (tui, theme, keybindings) =>
    instantiate(parent, tui, theme, keybindings);
  factory[EDITOR_FACTORY_LAYER] = { id, priority, parent, instantiate };
  return factory;
}

export function hasEditorFactoryLayer(factory: EditorFactory | undefined, id: string): boolean {
  const metadata = layerMetadata(factory);
  if (!metadata) return false;
  return metadata.id === id || hasEditorFactoryLayer(metadata.parent, id);
}

export function installEditorFactoryLayer(
  current: EditorFactory | undefined,
  id: string,
  priority: number,
  instantiate: EditorLayerInstantiate,
): EditorFactory {
  if (hasEditorFactoryLayer(current, id)) return current as EditorFactory;

  const metadata = layerMetadata(current);
  if (metadata && metadata.priority > priority) {
    const parent = installEditorFactoryLayer(metadata.parent, id, priority, instantiate);
    return createLayerFactory(parent, metadata.id, metadata.priority, metadata.instantiate);
  }

  return createLayerFactory(current, id, priority, instantiate);
}

export function removeEditorFactoryLayer(
  current: EditorFactory | undefined,
  id: string,
): EditorFactory | undefined {
  const metadata = layerMetadata(current);
  if (!metadata) return current;
  if (metadata.id === id) return metadata.parent;

  const parent = removeEditorFactoryLayer(metadata.parent, id);
  if (parent === metadata.parent) return current;
  return createLayerFactory(parent, metadata.id, metadata.priority, metadata.instantiate);
}
