# Consistency audit — remaining work

This list contains 39 low-severity findings from the audit of 27 extensions. Paths and line numbers come from the audit; entries marked `(verified)` were checked again.

---

## 1. Open README / doc gaps

- [low] neuralwatt/README.md — "Pi APIs Used" table omits `pi.on("before_provider_request")` (neuralwatt.ts:93) and `pi.events.emit(FLEX_EVENT)` (neuralwatt.ts:50) (verified)
- [low] worker-blocker/README.md:7 + worker-blocker.ts:7 — "as an `workers_blocker` marker" → "as a" (verified)
- [low] approval-mode/README.md — the `--worker-readonly` flag (approval-mode.ts:41) is undocumented (verified)
- [low] test/extensions/session-recap.test.ts:665 — comment says "< 30 words"; the threshold is 50 (verified)

---

## 2. Open code findings — low

- [low] voice/src/summary.ts:166 — `(tui: any, theme: any)` erases widget component types
- [low] voice/src/overlay.ts:101 — stray `// 0.5s` comment
- [low] voice/src/overlay.ts:262-277 — `ctx.ui.custom` rejection skips `cleanup()`; recorder child process and timers leak; wrap in try/finally
- [low] voice/src/constants.ts:19 — `HOLD_REPEAT_INITIAL_GAP_MS` unused (verified)
- [low] voice/src/transcription.ts:224-231 vs 324-332 — offline decode + anti-loop sequence repeated; extract one helper
- [low] btw/btw.ts:144,165,194,228,278 — the same 8-line thread-reset block repeats 5×; extract one closure helper
- [low] btw/btw.ts:5 — header comment says rows framed by hand with `frameLine`; overlay uses `renderModalFrame`
- [low] btw/src/transcript.ts:202 — inline dynamic `import(...)` type; move to top-level `import type`
- [low] btw/src/thread.ts:61-66 — identical assistant/toolResult branches in `cloneThreadState`
- [low] btw/src/handoff.ts:80 — inline `12000` cap; name a constant
- [low] workers/workers.ts:21 — no `// --- Imports ---` section header
- [low] workers/src/store.ts:78,454 — comments in French; translate (verified)
- [low] workers/src/delegate.ts:314 — recomputes `extensionsRoot` already defaulted by worker-extensions.ts
- [low] workers — `abortDetail`/`abortReason` (runner.ts:573 vs provision/hook.ts:27) and assistant text extraction (runner.ts:218-225 vs format.ts:165-172) duplicated within the extension
- [low] missions/src/actions.ts:141-148 — corrupt active-mission file degrades to "no active mission" with `console.error` only; notify "warning" when a UI exists
- [low] missions/src/actions.ts:41 — `MissionToolParams = Record<string, any>`; use `unknown`
- [low] missions/src/format.ts:14,21 — `statusText`/`progressText` exported but module-private in practice
- [low] autoresearch/src/types.ts:88-89 — two stacked JSDoc comments on `spread`; the first contradicts the no-noise-floor rule in src/stats.ts:8-10
- [low] autoresearch/src/format.ts:16-19,87 — status icon/color constants and `statusText` exported but unimported
- [low] codex-image/codex-image.ts:1-2 — runtime `typebox` import after `import type ... from "pi"`; swap
- [low] codex-image/codex-image.ts:24-26 — constants under `// --- Extension ---`; add `// --- Constants ---`
- [low] codex-image/codex-image.ts:33 — hardcodes `5`; import `MAX_INPUT_IMAGES` from src/output.ts:29
- [low] codex-image/codex-image.ts:56-90 — `generate_image` ships no `renderResult`; consider lib/tool-renderer
- [low] web-search/src/html.ts:36-45 — `decodeHtmlEntities` replaces `&amp;` first, so double-encoded entities decode twice
- [low] web-search/src/rendering.ts:13 — pointless `wrapMultilineText = wrapToolText` alias
- [low] synthetic/src/catalog.ts:31-35 + neuralwatt/src/catalog.ts:33-37 — errors return `[]` silently; network failure indistinguishable from an in-sync catalog
- [low] messenger/src/watcher.ts:42,61-62 — two empty catches swallow watcher failures (comments document the fallback); add a debug log
- [low] messenger/messenger.ts:19 — imports lack the `// --- Imports ---` header
- [low] worker-model/src/config.ts:73-79 — `configuredWorkerModelLabel` has no caller and swallows config errors
- [low] background-jobs/src/runner.ts:136 — `appendFile(job.spoolPath as string, ...)` cast; assign a typed local
- [low] background-jobs/src/jobs.ts:78-79 — `options.jobId as number` cast twice around `Number.isFinite`
- [low] background-jobs/src/format.ts:43 + src/jobs.ts:151,315 — status-to-mark mapping duplicated; one shared status table in format.ts
- [low] approval-mode/src/jev.ts:5 + src/policy.ts:3 — `// --- Types ---` precedes `// --- Constants ---`; swap
- [low] status-bar/src/editor.ts:157-160 — `PolishedEditor` doc comment stranded ~55 lines above its class by a section comment
- [low] status-bar/src/editor.ts:190-200 — per-session prompt-history map grows unbounded per session; bound or prune on `session_shutdown`
