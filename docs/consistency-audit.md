# Consistency audit — closed

All 39 low-severity findings from the audit of 27 extensions are closed. The checked entries record the original findings; paths and line numbers refer to the original audit.

## 1. README / doc gaps

- [x] neuralwatt/README.md — Documented `pi.on("before_provider_request")` and `pi.events.emit(FLEX_EVENT)` in the Pi APIs table.
- [x] worker-blocker/README.md + worker-blocker.ts — Corrected "an `workers_blocker` marker" to "a `workers_blocker` marker". Corrected the same wording in lib/worker-blocker.ts.
- [x] approval-mode/README.md — Documented `--worker-readonly`, its worker-only scope, and its separate sandbox enforcement.
- [x] test/extensions/session-recap.test.ts — Corrected the short-message comment to match the 50-word threshold.

## 2. Code findings — low

- [x] voice/src/summary.ts:166 — `(tui: any, theme: any)` erases widget component types
- [x] voice/src/overlay.ts:101 — stray `// 0.5s` comment
- [x] voice/src/overlay.ts:262-277 — `ctx.ui.custom` rejection skips `cleanup()`; recorder child process and timers leak
- [x] voice/src/constants.ts:19 — `HOLD_REPEAT_INITIAL_GAP_MS` unused
- [x] voice/src/transcription.ts:224-231 vs 324-332 — offline decode + anti-loop sequence repeated
- [x] btw/btw.ts:144,165,194,228,278 — the same 8-line thread-reset block repeats 5×
- [x] btw/btw.ts:5 — header comment says rows framed by hand with `frameLine`; overlay uses `renderModalFrame`
- [x] btw/src/transcript.ts:202 — inline dynamic `import(...)` type
- [x] btw/src/thread.ts:61-66 — identical assistant/toolResult branches in `cloneThreadState`
- [x] btw/src/handoff.ts:80 — inline `12000` cap
- [x] workers/workers.ts:21 — no `// --- Imports ---` section header
- [x] workers/src/store.ts:78,454 — comments in French
- [x] workers/src/delegate.ts:314 — recomputes `extensionsRoot` already defaulted by worker-extensions.ts
- [x] workers — `abortDetail`/`abortReason` (runner.ts:573 vs provision/hook.ts:27) and assistant text extraction (runner.ts:218-225 vs format.ts:165-172) duplicated within the extension
- [x] missions/src/actions.ts:141-148 — corrupt active-mission file degrades to "no active mission" with `console.error` only; now warns when a UI exists
- [x] missions/src/actions.ts:41 — `MissionToolParams = Record<string, any>`
- [x] missions/src/format.ts:14,21 — `statusText`/`progressText` exported but module-private in practice
- [x] autoresearch/src/types.ts:88-89 — two stacked JSDoc comments on `spread`; the first contradicts the no-noise-floor rule in src/stats.ts:8-10
- [x] autoresearch/src/format.ts:16-19,87 — status icon/color constants and `statusText` exported but unimported
- [x] codex-image/codex-image.ts:1-2 — runtime `typebox` import after `import type ... from "pi"`
- [x] codex-image/codex-image.ts:24-26 — constants under `// --- Extension ---`
- [x] codex-image/codex-image.ts:33 — hardcodes `5` instead of using `MAX_INPUT_IMAGES`
- [x] codex-image/codex-image.ts:56-90 — considered `renderResult`; retained Pi's default renderer because a text-only renderer hides the generated image preview
- [x] web-search/src/html.ts:36-45 — `decodeHtmlEntities` decoded double-encoded entities twice
- [x] web-search/src/rendering.ts:13 — redundant `wrapMultilineText = wrapToolText` alias
- [x] synthetic/src/catalog.ts:31-35 + neuralwatt/src/catalog.ts:33-37 — errors returned `[]` silently; failures now return `undefined` and log a debug diagnostic without a UI warning
- [x] messenger/src/watcher.ts:42,61-62 — empty catches swallowed watcher failures; failures now log a debug diagnostic
- [x] messenger/messenger.ts:19 — imports lacked the `// --- Imports ---` header
- [x] worker-model/src/config.ts:73-79 — unused `configuredWorkerModelLabel` swallowed config errors
- [x] background-jobs/src/runner.ts:136 — `appendFile(job.spoolPath as string, ...)` cast
- [x] background-jobs/src/jobs.ts:78-79 — `options.jobId as number` cast twice around `Number.isFinite`
- [x] background-jobs/src/format.ts:43 + src/jobs.ts:151,315 — status-to-mark mapping duplicated
- [x] approval-mode/src/jev.ts:5 + src/policy.ts:3 — `// --- Types ---` preceded `// --- Constants ---`
- [x] status-bar/src/editor.ts:157-160 — `PolishedEditor` doc comment separated from its class
- [x] status-bar/src/editor.ts:190-200 — per-session prompt-history map grew without a session limit
