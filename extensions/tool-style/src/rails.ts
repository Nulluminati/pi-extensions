// --- Imports ---

import type {
  BashExecutionComponent,
  CustomMessageComponent,
  Theme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { toBackgroundAnsi } from "./surface.ts";

// --- Constants ---

const RENDER_PATCH_PROPERTY = "__piToolStyleRailPatch__";
const THEME_PATCH_PROPERTY = "__piToolStyleBackgroundPatch__";
const RAIL = "▏";
const BACKGROUND_RESET = "\u001b[49m";
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const STYLED_BACKGROUNDS = new Set([
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
]);

// --- Types ---

type ThemeColor = "accent" | "success" | "error" | "warning" | "bashMode" | "customMessageLabel";
type ThemeBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type RenderFunction = (this: RenderInstance, width: number) => string[];

interface RenderInstance {
  isPartial?: boolean;
  result?: { isError?: boolean };
  status?: "running" | "complete" | "error" | "cancelled";
  toolName?: string;
  command?: string;
}

interface RenderPrototype {
  render: RenderFunction;
  [RENDER_PATCH_PROPERTY]?: PatchRecord<RenderFunction>;
}

interface ComponentClass {
  prototype: RenderPrototype;
}

interface ThemePrototype {
  bg: (this: Theme, color: string, text: string) => string;
  getBgAnsi: (this: Theme, color: string) => string;
  [THEME_PATCH_PROPERTY]?: ThemePatchRecord;
}

interface ThemeClass {
  prototype: ThemePrototype;
}

interface PatchRecord<T> {
  wrapper: T;
  restore(): void;
}

interface ThemePatchRecord {
  bgWrapper: ThemePrototype["bg"];
  restore(): void;
}

interface RailTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeBackground, text: string): string;
}

export interface RailController {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  restore(): void;
}

export interface RailTargets {
  ToolExecutionComponent: typeof ToolExecutionComponent;
  BashExecutionComponent: typeof BashExecutionComponent;
  CustomMessageComponent: typeof CustomMessageComponent;
  Theme: typeof Theme;
}

// --- State colors ---

function getToolColor(instance: RenderInstance): ThemeColor {
  if (instance.isPartial !== false) return "accent";
  return instance.result?.isError ? "error" : "success";
}

function getBashColor(instance: RenderInstance): ThemeColor {
  switch (instance.status) {
    case "complete":
      return "success";
    case "error":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return "bashMode";
  }
}

function getBashBackground(instance: RenderInstance): ThemeBackground {
  switch (instance.status) {
    case "complete":
      return "toolSuccessBg";
    case "error":
    case "cancelled":
      return "toolErrorBg";
    default:
      return "toolPendingBg";
  }
}

// --- Render styling ---

function addRail(
  original: RenderFunction,
  instance: RenderInstance,
  width: number,
  color: ThemeColor,
  theme: RailTheme,
  styleDirectCommand: boolean,
  onRenderFailure?: (instance: RenderInstance) => void,
): string[] {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const innerWidth = normalizedWidth === 1 ? 1 : normalizedWidth - 1;
  let rendered: string[];
  try {
    rendered = original.call(instance, innerWidth);
  } catch {
    // A component render throwing (e.g. pi's unguarded addChild(undefined) when
    // a tool renderer returns undefined) must not kill the whole session.
    // Degrade to an empty block and report the failure instead.
    onRenderFailure?.(instance);
    return [];
  }
  const lines = styleDirectCommand ? removeDirectCommandBorders(rendered) : rendered;
  if (lines.length === 0) return lines;
  const rail = theme.fg(color, RAIL);

  return lines.map((line, index) => {
    if (index === 0) return line;
    if (!styleDirectCommand) return normalizedWidth === 1 ? rail : `${rail}${line}`;

    const content = normalizedWidth === 1 ? "" : line;
    const padding =
      normalizedWidth === 1 ? "" : " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
    return theme.bg(getBashBackground(instance), `${rail}${content}${padding}`);
  });
}

function removeDirectCommandBorders(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const leadingSpacer = lines[0] === "" ? [""] : [];
  const content = leadingSpacer.length > 0 ? lines.slice(1) : [...lines];
  if (isBorderLine(content[0])) content.shift();
  if (isBorderLine(content.at(-1))) content.pop();
  return [...leadingSpacer, ...content];
}

function isBorderLine(line: string | undefined): boolean {
  if (!line) return false;
  const visible = line.replace(ANSI_PATTERN, "").trim();
  return visible.length > 0 && /^─+$/.test(visible);
}

function patchRenderer(
  target: ComponentClass,
  getColor: (instance: RenderInstance) => ThemeColor,
  getTheme: () => RailTheme,
  isEnabled: () => boolean,
  styleDirectCommand = false,
  onRenderFailure?: (instance: RenderInstance) => void,
): () => void {
  const prototype = target.prototype;
  prototype[RENDER_PATCH_PROPERTY]?.restore();

  const original = prototype.render;
  const wrapper: RenderFunction = function (width) {
    if (!isEnabled()) return original.call(this, width);
    return addRail(
      original,
      this,
      width,
      getColor(this),
      getTheme(),
      styleDirectCommand,
      onRenderFailure,
    );
  };
  const restore = () => {
    if (prototype.render === wrapper) prototype.render = original;
    if (prototype[RENDER_PATCH_PROPERTY]?.wrapper === wrapper) {
      delete prototype[RENDER_PATCH_PROPERTY];
    }
  };
  Object.defineProperty(prototype, RENDER_PATCH_PROPERTY, {
    configurable: true,
    value: { wrapper, restore } satisfies PatchRecord<RenderFunction>,
  });
  prototype.render = wrapper;
  return restore;
}

// --- Theme background styling ---

function patchThemeBackground(
  target: ThemeClass,
  getSurface: () => string | undefined,
  isEnabled: () => boolean,
): () => void {
  const prototype = target.prototype;
  prototype[THEME_PATCH_PROPERTY]?.restore();

  const originalBg = prototype.bg;
  const originalGetBgAnsi = prototype.getBgAnsi;
  const getStyledAnsi = (color: string) => {
    if (!isEnabled() || !STYLED_BACKGROUNDS.has(color)) return undefined;
    const surface = getSurface();
    return surface ? toBackgroundAnsi(surface) : undefined;
  };
  const bgWrapper: ThemePrototype["bg"] = function (color, text) {
    const ansi = getStyledAnsi(color);
    return ansi ? `${ansi}${text}${BACKGROUND_RESET}` : originalBg.call(this, color, text);
  };
  const getBgAnsiWrapper: ThemePrototype["getBgAnsi"] = function (color) {
    return getStyledAnsi(color) ?? originalGetBgAnsi.call(this, color);
  };
  const restore = () => {
    if (prototype.bg === bgWrapper) prototype.bg = originalBg;
    if (prototype.getBgAnsi === getBgAnsiWrapper) prototype.getBgAnsi = originalGetBgAnsi;
    if (prototype[THEME_PATCH_PROPERTY]?.bgWrapper === bgWrapper) {
      delete prototype[THEME_PATCH_PROPERTY];
    }
  };
  Object.defineProperty(prototype, THEME_PATCH_PROPERTY, {
    configurable: true,
    value: { bgWrapper, restore } satisfies ThemePatchRecord,
  });
  prototype.bg = bgWrapper;
  prototype.getBgAnsi = getBgAnsiWrapper;
  return restore;
}

// --- Rail controller ---

export function installRailStyles(
  targets: RailTargets,
  getTheme: () => RailTheme,
  getSurface: () => string | undefined,
  initiallyEnabled = true,
  onRenderFailure?: (instance: RenderInstance) => void,
): RailController {
  let enabled = initiallyEnabled;
  let restored = false;
  const isEnabled = () => enabled;
  const restores = [
    patchThemeBackground(targets.Theme, getSurface, isEnabled),
    patchRenderer(
      targets.ToolExecutionComponent,
      getToolColor,
      getTheme,
      isEnabled,
      false,
      onRenderFailure,
    ),
    patchRenderer(
      targets.BashExecutionComponent,
      getBashColor,
      getTheme,
      isEnabled,
      true,
      onRenderFailure,
    ),
    patchRenderer(
      targets.CustomMessageComponent,
      () => "customMessageLabel",
      getTheme,
      isEnabled,
      false,
      onRenderFailure,
    ),
  ];

  return {
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = value;
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const restore of restores.reverse()) restore();
    },
  };
}
