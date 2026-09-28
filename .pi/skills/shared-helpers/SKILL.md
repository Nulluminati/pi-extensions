---
name: shared-helpers
description: Use the shared helper modules in lib/ when building or modifying Pi extensions in this repo. Covers session entry parsing (session-utils), cheap model resolution (small-model), modal frames (tui-frame), single-line input modals (input-modal), status lines and key hints (ui-format), tool result renderers (tool-renderer), searchable select modals (searchable-select), editor factory layering (editor-factory), sharded presence registries with dead-pid pruning (presence-shards), and canonical config/state/cache locations (paths). Use whenever an extension needs TUI rendering, a status line, a picker dialog, a text prompt, a custom editor wrapper, transcript parsing, a cheap direct LLM call, or a place to store config or state — import the lib/ helper instead of reimplementing the pattern.
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
| Build a `/smallmodel`-style config command or read the user's saved small-model choice | `loadSmallModelConfig`, `saveSmallModelConfig`, `parseSmallModelSpec` | `lib/small-model.ts` |
| Draw a bordered modal dialog with a title | `renderModalFrame`, `modalContentWidth` | `lib/tui-frame.ts` |
| Build a framed editor-widget panel (jobs, todos, missions, workers, autoresearch) | `createFramedWidget` | `lib/framed-widget.ts` |
| Publish an editor widget with a guaranteed, churn-free position (recap first, then workers/jobs/todos/missions/autoresearch) | `setStripWidget`, `WIDGET_PRIORITY` | `lib/widget-strip.ts` |
| Show an icon + colored status in the footer/status area | `formatStatusLine` | `lib/ui-format.ts` |
| Render a "key: action" hint bar inside a dialog | `formatStyledKeyHints`, `formatKeyHints` | `lib/ui-format.ts` |
| Write a `renderResult` for a registered tool | `createToolStatus`, `wrapToolText` | `lib/tool-renderer.ts` |
| Let the user fuzzy-pick from a list in a modal | `createSearchableSelectModal` | `lib/searchable-select.ts` |
| Prompt for one line of text in a framed modal | `promptText`, `createInputModal` | `lib/input-modal.ts` |
| Ask a yes/no question in a framed modal | `confirmModal`, `createConfirmModal` | `lib/input-modal.ts` |
| Wrap/replace the editor component (`ctx.ui.setEditorComponent`) | `installEditorFactoryLayer`, `hasEditorFactoryLayer`, `removeEditorFactoryLayer` | `lib/editor-factory.ts` |
| Write config/state JSON without risking a torn file on crash | `writeJsonAtomic` | `lib/json-atomic.ts` |
| Mutate shared state files across sessions without clobbering | `withFileLock` | `lib/file-lock.ts` |
| Resolve where an extension stores config, state, cache, or project files | `agentConfigPath`, `agentStateDir`, `cacheDir`, `projectStateDir`, `projectStateRelative` | `lib/paths.ts` |
| Point a user-facing message at Pi's auth file | `authPath` | `lib/paths.ts` |
| Keep project-local state out of `git status` | `excludeFromGit` | `lib/git.ts` |
| Build a `/smallmodel`-style model picker (descriptions, searchable modal) | `formatModelDescription`, `selectModelWithSearch` | `lib/model-picker.ts` |
| Share live presence (who is online) between concurrent sessions | `writeShard`, `loadShards`, `removeShard`, `readShard` | `lib/presence-shards.ts` |

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

## `lib/framed-widget.ts` — framed editor widgets

Factory for the always-on panels above the editor (jobs, todos, missions, workers, autoresearch). `createFramedWidget({ title, titleRight?, getBodyLines, maxBodyLines? })` returns the `(tui, theme) => { render(width), invalidate() }` component `ctx.ui.setWidget` expects: body lines and the top-right label are computed at render time (read live state in the callbacks), lines are wrapped in `renderModalFrame` with `paddingY: 0`, overflow beyond `maxBodyLines` (default 8) collapses into a dim `↓ N more` line, and frames are cached per width until `invalidate()`.

```typescript
ctx.ui.setWidget(WIDGET_KEY, hasState ? createFramedWidget({
  title: "Jobs",
  titleRight: () => `${count()} running`,
  getBodyLines: (theme) => buildLines(theme),
}) : undefined);
```

Pass `undefined` to `setWidget` when there is nothing to show. For a theme richer than `{ fg }`, type the callbacks via the generic: `createFramedWidget<MyWidgetTheme>({…})`.

### Widget-first status rule

Extensions whose live state is shown in a framed editor widget (missions, agents, autoresearch) follow two rules so the surfaces stay consistent and never double-render:

1. **Keep the `ctx.ui.setStatus` fallback.** It is what pi's default footer shows when the bundled status bar is disabled (`/statusbar:toggle`). Never remove it; build it with `formatStatusLine`.
2. **Register the status key in the status bar's line-2 skip list** (`extensions/status-bar/src/constants.ts`, mirrored string like `MISSIONS_STATUS_KEY`). The custom footer skips widget-first keys on its second line because the widget already shows the state.

The same extensions publish their widget through the **widget strip** (`lib/widget-strip.ts`, `setStripWidget`) instead of `ctx.ui.setWidget` directly: pi stacks same-placement widgets in insertion order and re-setting a key sinks it to the end, so the strip re-renders entries by priority (recap 0, workers 10, jobs 20, todos 30, missions 40, autoresearch 50 — add new widgets to `WIDGET_PRIORITY` in the lib module, never call `ctx.ui.setWidget` for a content widget).

Messenger's unread count is the one line-1 exception: the status bar subscribes to `messenger:state` and renders `✉ N` next to the context usage bar; messenger's own `setStatus` entry remains its disabled-footer fallback and is likewise skipped on line 2.

## `lib/input-modal.ts` — framed text prompt

A single-line `Input` from pi-tui wrapped in `renderModalFrame`, with the same border/title/key-hint styling as the searchable select. Use `promptText(ctx, { title, placeholder, initialValue? })` from a command handler instead of `ctx.ui.input` when you want the modal look (goal and handoff do); it falls back to `ctx.ui.input` outside TUI mode and resolves `undefined` on cancel:

```typescript
const objective = await promptText(ctx, {
  title: "Goal",
  placeholder: "What should this run accomplish?",
  initialValue: state.objective, // prefilled for edits
});
if (!objective) return; // cancelled
```

Enter submits, Esc cancels. Use `createInputModal` directly only when embedding the input inside a larger custom component.

### `confirmModal` — framed yes/no dialog

Ask a confirmation question in a framed modal (same border, title, and key-hint styling as `promptText`); body lines word-wrap to the frame width. Use `confirmModal(ctx, { title, body })` from a command handler instead of raw `ctx.ui.confirm` whenever the user must approve a destructive action (clear, goal reset, btw reset/inject do); it falls back to plain `ctx.ui.confirm` outside TUI mode and resolves `false` without UI (matching pi's no-op confirm context):

```typescript
const confirmed = await confirmModal(ctx, {
  title: "Reset current goal?",
  body: `Goal: "${objective}"\n\nThis discards the goal and its usage counters.`,
});
if (!confirmed) return; // declined or cannot ask
```

Enter confirms, Esc cancels. Optional `confirmLabel` / `cancelLabel` override the hint text. Use `createConfirmModal` directly only when embedding the dialog in a larger custom component.

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
- Feed `complete` / `completeSimple` from `@earendil-works/pi-ai` with `auth.apiKey`, optional `auth.headers`/`auth.env`, and `reasoning` (pass it through; it's already `undefined` for non-reasoning models). For OpenCode Zen/Go models, `auth.headers` includes Pi's current per-session routing headers and preserves explicit provider overrides.
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

## `lib/paths.ts` — where extension state lives

Every filesystem location an extension owns resolves through this module. Never call
`homedir()`, never hardcode `.pi`, and never write into the agent's `extensions/` directory
(Pi uses it as an extension-discovery root, so state there collides with code loading).

| Resolver | Location | Use for |
|----------|----------|---------|
| `agentConfigPath(name)` | `<agentDir>/<name>.json` | Global config, sibling of Pi's `settings.json` |
| `agentStateDir(name)` | `<agentDir>/<name>/` | Global runtime state: logs, spools, locks |
| `cacheDir(name)` | `$XDG_CACHE_HOME/pi-<name>/` (default `~/.cache/pi-<name>/`) | Regenerable cache and downloaded models |
| `projectStateDir(cwd, name)` | `<cwd>/<CONFIG_DIR_NAME>/<name>/` | Project-scoped state |
| `projectStateRelative(name)` | `<CONFIG_DIR_NAME>/<name>` | Git-exclude patterns |

`isProjectStatePath(relativePath)` answers whether a project-relative path is extension state —
use it in clean-tree and git-hygiene checks rather than prefix-matching the config dir yourself.
It treats the config dir itself as state too, because `git status --porcelain` collapses a
wholly-untracked tree to `.pi/`.

`authPath()` returns Pi's `auth.json` inside the agent dir. Extensions never write it; use it in
messages that tell the user where a key belongs, so the path follows `PI_CODING_AGENT_DIR`.

## `lib/git.ts` — git exec and local excludes

`cleanGitEnv()` / `runGit(cwd, args)` run git with inherited index and worktree variables
stripped; use `runGit` instead of raw `execFile` so hooks like lint-staged cannot corrupt calls.

`excludeFromGit(cwd, pattern)` appends a pattern to the repository's local exclude file
(`.git/info/exclude`) without touching the tracked `.gitignore`. It is idempotent and a no-op
outside a repository, so extensions can call it on `session_start` to keep their project state
dir out of `git status`. The exclude path is resolved through git, so it works from linked
worktrees where `.git` is a file.

`<agentDir>` comes from `getAgentDir()` and honors `PI_CODING_AGENT_DIR`; project paths use
`CONFIG_DIR_NAME`, so rebranded distributions resolve to their own config directory. Both are
exported by `@earendil-works/pi-coding-agent`. `test/conventions.test.ts` fails the suite on a
`homedir()` call or literal `.pi` path segment under `extensions/` or `lib/`, allowlisting only
this module and `tool-style` (which reads pywal's cache, not its own state).

Ephemeral spills with no retention go in `os.tmpdir()` with a `pi-<name>-` prefix instead.

## `lib/json-atomic.ts` — atomic JSON writes

Crash-safe state file writes: `writeJsonAtomic(path, data)` pretty-prints `data`, writes a
`${path}.${pid}.${random}.tmp` sibling, then renames it over the target (rename is atomic),
creating parent directories as needed. Use for every persisted JSON state file (reservations,
missions, registries). Used by `messenger`, `missions`, `autoresearch`, `agents`, and
`lib/presence-shards`.

## `lib/file-lock.ts` — cross-process advisory file lock

Mutual exclusion for read-modify-write cycles on shared files: `withFileLock(lockPath, fn,
options?)` runs `fn` holding a `wx`-created lock file. Waiters poll; a lock untouched for
`staleMs` (default 15s) is reclaimed as crashed, the holder refreshes its mtime every
`refreshMs` (default 5s) so long critical sections are never stolen, and `timeoutMs`
(default 30s, must be ≥ `staleMs`) caps the wait — `timeoutMessage` lets a consumer name its
domain in the error. Used by `messenger` (registry claims, reservations, mailbox compaction),
`missions` (mission saves, via an acquire/release adapter in its storage module) and `agents`
(worker registry read-modify-writes).

## `lib/model-picker.ts` — model picker pieces

Shared formatting and modal for `/smallmodel`- and `/worker-model`-style pickers:
`formatTokenCount` ("200k", "1.2m"), `formatModelDescription(model)` (name · ctx · out ·
capability flags), and `selectModelWithSearch(ctx, items, activeValue, title)` — the
`ui.custom` searchable modal used in TUI mode (resolves the selected value, `undefined` on
cancel; fall back to `ctx.ui.select` outside TUI). `ModelMetadata` is the shared model shape.
Config load/save stays in `lib/small-model.ts` / `lib/worker-model.ts`.

## `lib/presence-shards.ts` — sharded presence registry

Live presence shared by concurrent sessions. One shard file per agent: heartbeats only ever write the caller's own shard, so concurrent writers cannot clobber each other's entries. Reads merge all shards, fail closed on corrupt or unreadable shards (they are never silently deleted or read as absent), prune entries whose pid is dead, and can migrate a legacy single-file registry. Used by `messenger` (presence) and `agents` (pid liveness).

- `writeShard(dir, record)` / `readShard(dir, name)` / `removeShard(dir, name)` — per-agent operations.
- `loadShards(dir, { legacyPath? })` → `Record<name, record>` after pruning dead pids.
- Records must have `name: string` and `pid: number` plus whatever extra fields you need.
- Never write presence as a single shared JSON file — heartbeats are read-modify-write and concurrent settles clobber each other.

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
