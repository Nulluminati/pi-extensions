---
name: shared-helpers
description: Use the shared helper modules in lib/ when building or modifying Pi extensions in this repo. Covers session entry parsing (session-utils), cheap model resolution (small-model), modal frames (tui-frame), status lines and key hints (ui-format), tool result renderers (tool-renderer), searchable select modals (searchable-select), and editor factory layering (editor-factory). Use whenever an extension needs TUI rendering, a status line, a picker dialog, a custom editor wrapper, transcript parsing, or a cheap direct LLM call — import the lib/ helper instead of reimplementing the pattern.
---

# Shared Helpers in `lib/`

This repo's `lib/` directory holds helper modules shared by multiple extensions. **Always check here before writing TUI rendering, model resolution, or transcript-parsing code.** Duplicating these patterns produces visual and behavioral drift; the helpers exist so every extension looks and behaves consistently.

Import with a relative path and explicit `.ts` extension. The depth depends on the file:

```typescript
// From extensions/<name>/<name>.ts (root entrypoint):
import { formatStatusLine } from "../../lib/ui-format.ts";

// From extensions/<name>/src/<module>.ts:
import { renderModalFrame } from "../../../lib/tui-frame.ts";
```

`lib/` is shared infrastructure, not an extension. It is excluded from entrypoint discovery. Every helper module has its own behavioral tests under `test/lib/` — extension tests exercise lib behavior *through the extension*, not by re-testing the helper.

## Quick reference: which helper for which job

| You need to… | Use | Module |
|---|---|---|
| Read text / tool calls / tool results from `sessionManager.getBranch()` entries | `extractText`, `extractToolCallBlocks`, `extractToolResultBlocks`, `parseContentBlocks` | `lib/session-utils.ts` |
| Make a cheap one-off LLM call (summaries, side agents, recaps) | `resolveSmallModel` (+ `complete` / `completeSimple` from `@earendil-works/pi-ai`) | `lib/small-model.ts` |
| Build a `/small-model`-style config command or read the user's saved small-model choice | `loadSmallModelConfig`, `saveSmallModelConfig`, `parseSmallModelSpec` | `lib/small-model.ts` |
| Draw a bordered modal dialog with a title | `renderModalFrame`, `modalContentWidth` | `lib/tui-frame.ts` |
| Show an icon + colored status in the footer/status area | `formatStatusLine` | `lib/ui-format.ts` |
| Render a "key: action" hint bar inside a dialog | `formatStyledKeyHints`, `formatKeyHints` | `lib/ui-format.ts` |
| Write a `renderResult` for a registered tool | `createToolStatus`, `wrapToolText` | `lib/tool-renderer.ts` |
| Let the user fuzzy-pick from a list in a modal | `createSearchableSelectModal` | `lib/searchable-select.ts` |
| Wrap/replace the editor component (`ctx.ui.setEditorComponent`) | `installEditorFactoryLayer`, `hasEditorFactoryLayer`, `removeEditorFactoryLayer` | `lib/editor-factory.ts` |

---

## `lib/ui-format.ts` — status lines and key hints

Two jobs, both pure string formatting against a theme:

- `formatStatusLine(theme, { icon, prefix, text, iconColor?, textColor? })` produces `"<icon> <Prefix>: <text>"` with theme colors (defaults: icon `accent`, text `muted`). Feed the result to `ctx.ui.setStatus(STATUS_KEY, text)`; pass `undefined` to clear.
- `formatStyledKeyHints(theme, [["enter", "select"], ["esc", "cancel"]])` produces a themed hint bar for the bottom of a dialog. `formatKeyHints` is the unthemed variant for plain-text contexts.

Canonical status pattern (from `goal`, `handoff`, `web-search`):

```typescript
function updateStatusLine(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  const text = state ? buildStatusText(state) : undefined;
  ctx.ui.setStatus(
    STATUS_KEY,
    text === undefined
      ? undefined
      : formatStatusLine(ctx.ui.theme, {
          icon: STATUS_ICON,
          prefix: "Goal",
          text,
          iconColor: ICON_COLOR,
          textColor: TEXT_COLOR,
        }),
  );
}
```

Always guard with `ctx.hasUI` and keep the status key, icon, and colors in module constants.

## `lib/tui-frame.ts` — modal frames

Wraps an array of rendered body lines in a rounded border with a title, padding, and optional fixed body height (overflow collapses to a `↓ N more lines` footer):

```typescript
render(width: number): string[] {
  return renderModalFrame(theme, width, bodyLines, { title: "BTW" });
}
```

- Compute body width with `modalContentWidth(width)` and render your content into that narrower width; the frame adds the border and padding around it.
- Small widths are handled: below 4 columns the frame degrades to truncated raw lines. You don't need width guards beyond the empty case.
- Lower-level pieces (`frameBorderLine`, `frameRuleLine`, `frameContentLine`) exist for custom layouts, but prefer `renderModalFrame` so all dialogs share one visual language.

## `lib/searchable-select.ts` — fuzzy picker modal

A search-input + select-list modal composed from pi-tui's `Input` and `SelectList`, already framed by `renderModalFrame`. Use it inside `ctx.ui.custom` whenever a command needs the user to pick one item from a list (providers, models, sessions):

```typescript
const selectedId = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) =>
  createSearchableSelectModal({
    tui,
    theme,
    keybindings,
    items,                    // SelectItem[] from @earendil-works/pi-tui
    activeValue: currentId,   // highlighted as the current choice
    title: "Web Search",
    maxVisible: 10,
    noMatchText: "No matching providers",
    onSelect: done,
    onCancel: () => done(null),
  }),
);
```

Rules of use:

- Provide `onSelect` and `onCancel`; both typically call `done`. Resolve with `null`/`undefined` on cancel and treat that as "user aborted."
- For non-TUI modes (`ctx.mode !== "tui"`), fall back to `ctx.ui.select` — see `web-search`'s `selectProvider` for the dual-path pattern.
- Use the exported `SearchableSelect` class directly only when you need the selector *without* the modal frame (e.g. embedding it in a larger component).

## `lib/tool-renderer.ts` — compact tool result renderers

Two primitives for a tool's `renderResult`:

- `createToolStatus(theme, color, text)` returns a one-line component for collapsed/partial/error states. Conventions in use: `"warning"` while streaming, `"error"` on failure, `"success"` for the collapsed summary.
- `wrapToolText(text, width)` word-wraps multi-line text (ANSI-aware, preserves blank lines) for the expanded view.

Canonical shape (from `grep-app`, `web-search`):

```typescript
if (isError) return createToolStatus(theme, "error", `✗ Grep: "${query}" — ${errorText}`);
if (options.isPartial) return createToolStatus(theme, "warning", `🔍 Grep: "${query}"...`);
if (options.expanded) {
  return {
    render: (width: number) => wrapToolText(text, width),
    invalidate: () => {},
  };
}
return createToolStatus(theme, "success", `🔍 Grep: "${query}" — ${label}`);
```

## `lib/session-utils.ts` — parsing session branch entries

Session message content is `string | Array<block>` where blocks vary by shape. These helpers normalize that mess:

- `parseContentBlocks(content)` — normalize string-or-array content into typed blocks.
- `extractText(content)` — concatenate all text blocks (joined with `\n`).
- `extractToolCallBlocks(content)` / `extractToolResultBlocks(content)` — pull tool calls (with `name`, `arguments`) and results.

Reach for these any time you walk `ctx.sessionManager.getBranch()` to build a transcript, recap, or background summary (see `session-recap/src/transcript.ts`). Never hand-roll `typeof content === "string"` / `Array.isArray` filtering per extension.

## `lib/small-model.ts` — cheap direct LLM calls

Resolves the user's globally configured "small model" — a cheap, fast model used for background work (summaries, side questions, recaps) that shouldn't consume the main model's context or cost. Used by `btw`, `handoff`, `voice`, and `session-recap`.

- `resolveSmallModel(ctx)` → `{ model, auth, config, source, reasoning }`. Throws descriptive errors when unconfigured, unknown, or missing credentials — **catch and surface via `ctx.ui.notify(..., "error")`**, then abort the operation.
- Feed `complete` / `completeSimple` from `@earendil-works/pi-ai` with `auth.apiKey`, optional `auth.headers`/`auth.env`, and `reasoning` (pass it through; it's already `undefined` for non-reasoning models).
- Configuration: `PI_SMALL_MODEL` env var (`provider/model-id`, wins over file) or the config file at `PI_SMALL_MODEL_CONFIG` / `<agentDir>/small-model.json`. Thinking level via `PI_SMALL_MODEL_THINKING` or the config's `thinkingLevel`.
- Only use `loadSmallModelConfig` / `saveSmallModelConfig` / `parseSmallModelSpec` when building a picker/configurator UI (the `small-model` extension owns this). Consumers should call `resolveSmallModel` and nothing else.

Canonical pattern (from `handoff/src/summary.ts`):

```typescript
let resolved: Awaited<ReturnType<typeof resolveSmallModel>>;
try {
  resolved = await resolveSmallModel(ctx);
} catch (error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
const response = await completeSimple(resolved.model, payload, {
  apiKey: resolved.auth.apiKey,
  ...(resolved.auth.headers ? { headers: resolved.auth.headers } : {}),
  ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}),
  maxTokens: SUMMARY_MAX_TOKENS,
  signal: ctx.signal,
});
```

In tests, drive configuration with `vi.stubEnv("PI_SMALL_MODEL", "provider/model")` and register a matching fake model on the mock `modelRegistry` — never stub the filesystem config path.

## `lib/editor-factory.ts` — layering custom editors

Pi lets extensions replace the editor component via `ctx.ui.setEditorComponent(factory)`, but naive replacement breaks when two extensions both customize it. This module composes editor factories as an ordered layer stack (higher priority wraps lower), with install/remove by id:

```typescript
const EDITOR_LAYER_ID = "my-ext-editor";

function installEditor(ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
  if (hasEditorFactoryLayer(current, EDITOR_LAYER_ID)) return; // idempotent

  const factory = installEditorFactoryLayer(
    current,
    EDITOR_LAYER_ID,
    0, // priority: behavior layers (e.g. voice's hold-to-talk) use high values; visual layers low
    (parent, tui, theme, keybindings) => {
      const base = parent?.(tui, theme, keybindings);
      return new MyEditor(tui, theme, keybindings, base);
    },
  );
  ctx.ui.setEditorComponent(factory);
}

function restoreEditor(ctx: ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  const current = ctx.ui.getEditorComponent() as EditorFactory | undefined;
  const restored = removeEditorFactoryLayer(current, EDITOR_LAYER_ID);
  if (restored !== current) ctx.ui.setEditorComponent(restored);
}
```

Mandatory rules (see `status-bar`, `voice`):

1. **Never call `setEditorComponent` with a bare factory.** Always go through `installEditorFactoryLayer` so your editor composes with others instead of clobbering them.
2. **Check `hasEditorFactoryLayer` before installing** — installation must be idempotent (session reloads re-fire lifecycle events).
3. **Always remove your layer on shutdown** with `removeEditorFactoryLayer`, and only call `setEditorComponent` when the stack actually changed (`restored !== current`).
4. **Inside `instantiate`, call the parent factory** and wrap its editor; only ignore the parent when you are deliberately replacing the base editor itself (status-bar's visual layer pattern).

## `lib/validate-extension.ts` — repo tooling, not extension code

This is the validator behind `npm run validate` / `validate:one`. Extensions never import it. If you change what makes a valid extension (allowed runtime modules, required APIs, entrypoint discovery), update this module and its tests in `test/validator.test.ts`.

---

## Rules

### MUST

1. **Import the helper instead of reimplementing it.** Modal frames, key-hint bars, status lines, fuzzy pickers, tool status lines, transcript parsing, small-model resolution, and editor layering all have exactly one implementation in this repo.
2. **Use the correct relative depth.** Entrypoints: `../../lib/<module>.ts`. `src/` modules: `../../../lib/<module>.ts`. Always with the `.ts` extension.
3. **Match the canonical usage patterns above.** The value of the helpers is uniformity — every status line, dialog, and tool renderer should read the same.
4. **Add `test/lib/<module>.test.ts` when you add a new lib module.** If a helper's behavior is genuinely reusable across two or more extensions, it belongs in `lib/` with its own suite; single-extension helpers stay in that extension's `src/`.
5. **Update this skill when you add or change a lib module.** The quick-reference table is the discovery surface.

### MUST NOT

1. **Do NOT copy-paste a lib function into an extension.** Extend the lib module or wrap it in your `src/` module.
2. **Do NOT move a helper into `lib/` for one consumer.** `lib/` is for patterns proven across extensions; premature extraction creates coupling.
3. **Do NOT re-test lib internals from extension tests.** Assert on the extension's observable behavior (status text set, `done` called with the selection); lib modules have their own suites in `test/lib/`.
4. **Do NOT import `lib/validate-extension.ts` from an extension.** It is build tooling.
