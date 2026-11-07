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
| Calculate session token usage and cost | `sumSessionUsage` | `lib/session-usage.ts` |
| Format user, assistant, and tool-result entries for a summary prompt | `formatTranscriptEntry` | `lib/transcript-prompt.ts` |
| Make a cheap one-off LLM call (summaries, side agents, recaps) | `resolveSmallModel` (+ `complete` / `completeSimple` from `@earendil-works/pi-ai`) | `lib/small-model.ts` |
| Build a `/smallmodel`-style config command or read the user's saved small-model choice | `loadSmallModelConfig`, `saveSmallModelConfig`, `parseSmallModelSpec` | `lib/small-model.ts` |
| Draw a bordered modal dialog with a title | `renderModalFrame`, `modalContentWidth` | `lib/tui-frame.ts` |
| Size a centered list or detail overlay | `PANEL_OVERLAY_OPTIONS` | `lib/overlay-options.ts` |
| Build a framed editor-widget panel (jobs, todos, missions, workers, autoresearch) | `createFramedWidget` | `lib/framed-widget.ts` |
| Publish an editor widget with a guaranteed, churn-free position (recap first, then workers/jobs/todos/missions/autoresearch) | `setStripWidget`, `WIDGET_PRIORITY` | `lib/widget-strip.ts` |
| Show an icon + colored status in the footer/status area | `formatStatusLine` | `lib/ui-format.ts` |
| Render a "key: action" hint bar inside a dialog | `formatStyledKeyHints`, `formatKeyHints` | `lib/ui-format.ts` |
| Write a `renderResult` for a registered tool | `createToolStatus`, `wrapToolText` | `lib/tool-renderer.ts` |
| Let the user fuzzy-pick from a list in a modal | `createSearchableSelectModal` | `lib/searchable-select.ts` |
| Prompt for one line of text in a framed modal | `promptText`, `createInputModal` | `lib/input-modal.ts` |
| Ask a yes/no question in a framed modal | `confirmModal`, `createConfirmModal` | `lib/input-modal.ts` |
| Wrap/replace the editor component (`ctx.ui.setEditorComponent`) | `installEditorFactoryLayer`, `hasEditorFactoryLayer`, `removeEditorFactoryLayer` | `lib/editor-factory.ts` |
| Run a one-shot shell command with bounded output and a timeout | `runExec` | `lib/exec.ts` |
| Write config/state JSON or JSONL without risking a torn file on crash | `writeJsonAtomic`, `writeTextAtomic` | `lib/json-atomic.ts` |
| Mutate shared state files across sessions without clobbering | `withFileLock` | `lib/file-lock.ts` |
| Resolve where an extension stores config, state, cache, or project files | `agentConfigPath`, `agentStateDir`, `cacheDir`, `projectConfigPath`, `projectStateDir`, `projectStateRelative` | `lib/paths.ts` |
| Point a user-facing message at Pi's auth file | `authPath` | `lib/paths.ts` |
| Keep project-local state out of `git status` | `excludeFromGit` | `lib/git.ts` |
| Format token counts with display-specific precision | `formatTokenCount` | `lib/token-count.ts` |
| Build a `/smallmodel`-style model picker and config flow | `formatModelDescription`, `selectModelWithSearch`, `createModelConfigFlow` | `lib/model-picker.ts` |
| Settle an abortable custom dialog once | `createSettleOnce` | `lib/settle-once.ts` |
| Match terminal arrow-key byte sequences | `isArrowUp`, `isArrowDown`, `isArrowLeft`, `isArrowRight` | `lib/arrow-keys.ts` |
| Resolve provider credentials or build Bearer headers | `resolveProviderApiKey`, `createProviderAuthHeaders` | `lib/provider-auth.ts` |
| Fetch a provider quota as authenticated JSON | `fetchProviderQuota` | `lib/provider-quota.ts` |
| Apply a fetch timeout and chain a caller abort signal | `createTimeoutController` | `lib/fetch-timeout.ts` |
| Format a provider's static model list | `formatProviderModelList` | `lib/provider-models.ts` |
| Share live presence (who is online) between concurrent sessions | `writeShard`, `loadShards`, `removeShard`, `readShard` | `lib/presence-shards.ts` |
| Parse shell command rules or share the effective parent list with workers | `parseAllowList`, `checkCommand`, `BASH_ALLOW_REQUEST_EVENT`, `BashAllowRequest` | `lib/bash-allow.ts` |
| Connect worker command approvals to the parent UI | `connectWorkerApprovalChannel`, `attachParentApprovalChannel`, `dispatchWorkerApproval` | `lib/worker-approval.ts` |
| Classify a shell command as hard-deny, known-safe, or needs-Jev | `classifyCommand`, `hasExecutionHook` | `lib/command-policy.ts` |
| Ask Approval Mode to review a shell command that an extension runs itself | `requestCommandReview`, `COMMAND_REVIEW_EVENT` | `lib/command-review.ts` |
| Run an extension's shell command in the active sandbox | `requestSandboxExec`, `SANDBOX_EXEC_EVENT` | `lib/sandbox-exec.ts` |

---

## `lib/ui-format.ts` — status lines and key hints

Two jobs, both pure string formatting against a theme:

- `formatStatusLine(theme, { icon, prefix, text, iconColor?, textColor? })` produces `"<icon> <Prefix>: <text>"` with theme colors (defaults: icon `accent`, text `muted`). Feed the result to `ctx.ui.setStatus(STATUS_KEY, text)`; pass `undefined` to clear.
- `formatStyledKeyHints(theme, [["enter", "select"], ["esc", "cancel"]])` produces a themed hint bar for the bottom of a dialog. `formatKeyHints` is the unthemed variant for plain-text contexts.

Canonical status pattern (from `missions`, `autoresearch`, `workers`):

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
          prefix: "Mission",
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

## `lib/overlay-options.ts` — centered panel dimensions

Use `PANEL_OVERLAY_OPTIONS` in `ctx.ui.custom` for a centered panel that is 70% wide and up to 80% tall. The todos, context, and background-jobs panels share this constant. Account for the 80% height limit when rendering frame borders and key hints.

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

Extensions whose live state is shown in a framed editor widget (missions, workers, autoresearch) follow two rules so the surfaces stay consistent and never double-render:

1. **Keep the `ctx.ui.setStatus` fallback.** It is what pi's default footer shows when the bundled status bar is disabled (`/statusbar:toggle`). Never remove it; build it with `formatStatusLine`.
2. **Register the status key in the status bar's line-2 skip list** (`extensions/status-bar/src/constants.ts`, mirrored string like `MISSIONS_STATUS_KEY`). The custom footer skips widget-first keys on its second line because the widget already shows the state.

The same extensions publish their widget through the **widget strip** (`lib/widget-strip.ts`, `setStripWidget`) instead of `ctx.ui.setWidget` directly: pi stacks same-placement widgets in insertion order and re-setting a key sinks it to the end, so the strip re-renders entries by priority (recap 0, workers 10, jobs 20, todos 30, missions 40, autoresearch 50 — add new widgets to `WIDGET_PRIORITY` in the lib module, never call `ctx.ui.setWidget` for a content widget).

Messenger's unread count is the one line-1 exception: the status bar subscribes to `messenger:state` and renders `✉ N` next to the context usage bar; messenger's own `setStatus` entry remains its disabled-footer fallback and is likewise skipped on line 2.

## `lib/input-modal.ts` — framed text prompt

A single-line `Input` from pi-tui wrapped in `renderModalFrame`, with the same border/title/key-hint styling as the searchable select. Use `promptText(ctx, { title, placeholder, initialValue? })` from a command handler instead of `ctx.ui.input` when you want the modal look; it falls back to `ctx.ui.input` outside TUI mode and resolves `undefined` on cancel:

```typescript
const name = await promptText(ctx, {
  title: "New project name",
  placeholder: "Name this project",
  initialValue: currentName, // prefilled for edits
});
if (!name) return; // cancelled
```

Enter submits, Esc cancels. `promptText` and `confirmModal` pass `blocked` to `ctx.ui.custom()`, so Pi reports the session as blocked while the dialog waits for an answer. Use `createInputModal` directly only when embedding the input inside a larger custom component.

### `confirmModal` — framed yes/no dialog

Ask a confirmation question in a framed modal (same border, title, and key-hint styling as `promptText`); body lines word-wrap to the frame width. Use `confirmModal(ctx, { title, body })` from a command handler instead of raw `ctx.ui.confirm` whenever the user must approve a destructive action (clear and btw reset/inject do); it falls back to plain `ctx.ui.confirm` outside TUI mode and resolves `false` without UI (matching pi's no-op confirm context):

```typescript
const confirmed = await confirmModal(ctx, {
  title: "Reset side thread?",
  body: "This wipes the whole side conversation and closes the side window.",
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
- Set `initialQuery` to restore the search input when results change.
- Supply `onSearchChange(query)` for remote search. The selector sends the input unchanged and does not filter supplied results locally. The owner controls request timing and cleanup.

## `lib/settle-once.ts` — abortable dialog settlement

`createSettleOnce(done, signal, abortValue)` returns `settle(value)` and `dispose()`. It calls `done` at most once and removes the abort listener before `done`. Call `dispose()` when the dialog component closes. Each consumer selects its own abort result and checks an already-aborted signal when required.

## `lib/arrow-keys.ts` — arrow-key byte matching

Use `isArrowUp`, `isArrowDown`, `isArrowLeft`, or `isArrowRight` for raw terminal fallback keys. Each matcher accepts CSI and application-cursor sequences. Check Pi keybindings first when available; raw bytes do not cover user rebindings or every terminal protocol.

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

## `lib/session-usage.ts` — session token/cost totals

`sumSessionUsage(entries)` sums provider-reported token usage and cost for one session branch. It counts assistant and `toolResult` messages, standalone `usage` entries, compaction entries, and branch-summary entries.

Nested calls already contribute to the parent `toolResult` usage. Do not count their details again.

The helper accepts numeric strings. It treats missing and non-finite numbers as zero. Cost accepts a number, a numeric string, or `{ total }`. It returns `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`.

`context` and `status-bar` use this helper. Use it when an extension shows session token usage or cost.

## `lib/transcript-prompt.ts` — transcript entries for prompts

`formatTranscriptEntry(entry)` renders a message as `User:`, `Assistant:`, or `Result(tool):` text. It trims text, caps user and assistant text at 1200 characters, caps tool results at 400 characters, and returns `undefined` for other entries. Consumers keep their own selection and total-length limits.

## `lib/small-model.ts` — cheap direct LLM calls

Resolves the user's globally configured "small model" — a cheap, fast model used for background work (summaries, side questions, recaps) that shouldn't consume the main model's context or cost. Used by `btw`, `handoff`, and `session-recap`.

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
    0, // priority: behavior layers use high values; visual layers low
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

Mandatory rules (see `status-bar`):

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
| `projectConfigPath(cwd, file)` | `<cwd>/<CONFIG_DIR_NAME>/<file>` | Project-owned config file, e.g. `sandbox.json` |
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
`homedir()` call, a direct `CONFIG_DIR_NAME` reference, or a literal `.pi` path segment under
`extensions/`, `lib/`, or `scripts/`. Its allowlist holds this module and a few files that read
paths this repo does not own, such as pywal's cache in `tool-style`, each with a reason.

Ephemeral spills with no retention go in `os.tmpdir()` with a `pi-<name>-` prefix instead.

## `lib/exec.ts` — bounded one-shot command execution

`runExec(command, { cwd, timeoutMs, maxBuffer? })` captures stdout and stderr and returns `{ ok, stdout, stderr, error?, durationMs }` without throwing. Callers format the result for their own domain. The command runs under `/bin/sh` in its own process group. At the timeout, the whole group gets SIGTERM, then SIGKILL after 1 s. A command that reaches the timeout always fails, even if it later exits 0. Use it for short, pipe-captured commands such as autoresearch measurement and mission verification. Do not use it for workers: their detached process group and file-backed streaming require separate lifecycle handling.

## `lib/json-atomic.ts` — atomic JSON writes

Crash-safe state file writes: `writeJsonAtomic(path, data)` pretty-prints JSON. For plain text such as JSONL, use `writeTextAtomic(path, text)`. Both write and sync a `${path}.${pid}.${random}.tmp` sibling, then rename it over the target (rename is atomic). They create parent directories as needed and remove the temp file if rename fails. Use `writeJsonAtomic` for every persisted JSON state file (reservations, missions, registries).

## `lib/file-lock.ts` — cross-process advisory file lock

Mutual exclusion for read-modify-write cycles on shared files: `withFileLock(lockPath, fn,
options?)` runs `fn` holding a `wx`-created lock file. Waiters poll; a lock untouched for
`staleMs` (default 15s) is reclaimed as crashed, the holder refreshes its mtime every
`refreshMs` (default 5s) so long critical sections are never stolen, and `timeoutMs`
(default 30s, must be ≥ `staleMs`) caps the wait — `timeoutMessage` lets a consumer name its
domain in the error. Used by `messenger` (registry claims, reservations, mailbox compaction),
`missions` (mission saves, via an acquire/release adapter in its storage module) and `workers`
(worker registry read-modify-writes).

## `lib/token-count.ts` — token count labels

`formatTokenCount(value, style?)` formats counts for model metadata and context breakdowns. The default style keeps model-picker labels. Context uses `{ underThousand: "raw", thousands: "fixed", millions: "fixed" }`. These styles preserve existing labels rather than changing the user interface.

## `lib/model-picker.ts` — model picker pieces

Shared formatting and modal for `/smallmodel`- and `/worker-model`-style pickers:
`formatTokenCount` ("200k", "1.2m"), `formatModelDescription(model)` (name · ctx · out ·
capability flags), and `selectModelWithSearch(ctx, items, activeValue, title)` — the
`ui.custom` searchable modal used in TUI mode (resolves the selected value, `undefined` on
cancel; fall back to `ctx.ui.select` outside TUI). The modal also reports Pi as blocked while it is open. `ModelMetadata` is the shared model shape.
`createModelConfigFlow(options)` shares model selection, validation, saving, thinking-level updates, and confirmation messages across the small-model and worker-model extensions. Pass extension-specific loaders, savers, titles, and validation/status callbacks. Config load/save stays in `lib/small-model.ts` / `lib/worker-model.ts`.

## `lib/fetch-timeout.ts` — network timeout and cancellation

`createTimeoutController({ timeoutMs, signal? })` returns a signal for `fetch` and a `cleanup()` function. Call `cleanup()` in `finally`, after the response body is read. It clears the timer and detaches the caller abort listener. A caller signal that is already aborted makes the returned signal abort immediately. Consumers own timeout durations and response/error policy.

## Provider helpers — hosted model catalogs

`lib/provider-auth.ts` resolves a model-registry key first, then falls back to the provider's environment variable. It also builds Bearer and JSON-accept headers. `lib/provider-quota.ts` fetches authenticated quota JSON with a timeout and caller abort signal. `lib/provider-models.ts` formats static model capabilities and prices for a `/provider:models` command. Synthetic and Neuralwatt share these helpers; keep provider-specific endpoints, timeout values, and response types in their extensions.

## `lib/presence-shards.ts` — sharded presence registry

Live presence shared by concurrent sessions. One shard file per agent: heartbeats only ever write the caller's own shard, so concurrent writers cannot clobber each other's entries. Reads merge all shards, fail closed on corrupt or unreadable shards (they are never silently deleted or read as absent), prune entries whose pid is dead, and can migrate a legacy single-file registry. Used by `messenger` (presence) and `workers` (pid liveness).

- `writeShard(dir, record)` / `readShard(dir, name)` / `removeShard(dir, name)` — per-agent operations.
- `loadShards(dir, { legacyPath? })` → `Record<name, record>` after pruning dead pids.
- Records must have `name: string` and `pid: number` plus whatever extra fields you need.
- Never write presence as a single shared JSON file — heartbeats are read-modify-write and concurrent settles clobber each other.

## `lib/bash-allow.ts` — shell command rules and worker inheritance

`parseAllowList`, `splitCommand`, and `checkCommand` implement the static command gate without loading Pi.
`BASH_ALLOW_REQUEST_EVENT` and `BashAllowRequest` define a synchronous parent-list snapshot request.
The parent `bash-allow` extension replies with its effective raw list, including empty or malformed values.
The worker launcher passes that value through `--bash-allow=<list>`; it uses `PI_BASH_ALLOW` only when no parent listener replies.
Do not read another extension's flag with `pi.getFlag`: Pi exposes only flags registered by the calling extension.

## `lib/worker-approval.ts` — worker approval channel

The worker runner creates a dedicated duplex pipe at descriptor `3` and sets `PI_WORKER_APPROVAL_FD`. Task output remains file-backed. `connectWorkerApprovalChannel` supplies the worker client; `attachParentApprovalChannel` supplies the parent server.

Each command requests live mode. Flagged commands send a separate approval request. The runner supplies trusted worker identity and uses `dispatchWorkerApproval` to emit `approval-mode:worker-request`. Approval Mode handles that event directly through its UI, not through model messages.

Replies apply to one request identifier. Cancellation, disconnection, malformed frames, and timeouts cannot grant approval. Close the channel on shutdown. Do not pass its descriptor to sandboxed command processes. Parent dialogs must use the request's abort signal, not the completed spawn turn's signal.

## `lib/command-policy.ts`, `lib/command-review.ts`, `lib/sandbox-exec.ts` — commands outside the `bash` tool

Use these modules when an extension runs a stored shell command itself, such as a mission verification command.

`classifyCommand(command, cwd)` returns `hard-deny`, `known-safe`, or `needs-jev`. Hard denies include recursive deletion of system roots, the workspace, and the Pi agent directory. Approval Mode and `requestCommandReview` share this policy.

Pass `pi.events` as `events`. `requestCommandReview(events, { ctx, command, cwd, source })` emits `approval-mode:command-review`. Approval Mode claims the request and applies its hard denies, Jev judgment, and dialog. With no claim, the helper refuses hard denies and approves other commands. The promise never rejects. Cancellation and reviewer errors resolve as a refusal.

`requestSandboxExec(events, { command, cwd, timeoutMs, maxOutputBytes, signal? })` emits `worker-sandbox:exec-request`. `worker-sandbox` claims the request while a sandbox is active. The promise resolves `undefined` when no sandbox claims it; the caller then runs the command on the host. A claimed sandbox that fails returns a failure and never falls back to the host. Check the abort signal again before a host run.

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
