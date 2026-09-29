# Consistency audit — remaining work

Nine read-only review workers audited all 27 extensions (~26,000 lines of TypeScript) against AGENTS.md, the extension-development / extension-structure / shared-helpers skills, and the root README. Baseline: 27/27 extensions validate, tests green.

Original result: 145 findings — 29 high, 49 medium, 67 low.

## Fix phase status

The docs pass and all 29 high-severity findings are resolved. Commits, in order:

- `84746b7` — audit report (superseded by this file)
- `1d27d31` — stale commands and claims fixed across 11 READMEs
- `8dcc734` — remaining README fixes + new `background-jobs` and `context` READMEs (all 27 extensions now have one)
- `21519bb` — status-bar flex listener registered at load time, not per session
- `32f94da` — web-search failed fetches set `details.isError`; goal UI calls guarded for non-TUI
- `7407d7a` — btw: `lib/session-utils` extractText, `ctx.signal` on summarize, `resolveSmallModel`-only display
- `02a1f4e` — context7: `writeJsonAtomic` + `withFileLock` around cache index writes
- `868cdb6` — context7: `createToolStatus` renderers, typed `renderResult` params
- `f9387d8` — autoresearch init lock, session-recap resume timer tracked, handoff `extractText`
- `c86c0c2` — workers status fallback + skip-list entry; voice config via `writeJsonAtomic` under `withFileLock`, `extractText`

Sections 1–3 remain open. Section 4 is complete. Citations come from the audit; line numbers were spot-re-verified against the current tree where marked `(verified)`.

---

## 1. Open code findings — medium

### Errors swallowed or mislabeled

- [medium] btw/src/handoff.ts:85 — `catch { return null; }` swallows the summarize failure; the caller shows a generic warning and the cause is lost
- [medium] btw/src/handoff.ts:52 — `runSummarize` ignores `_instructions`; `/btw:summarize <instructions>` never steers the summary prompt
- [medium] session-recap/src/engine.ts:128 — background (idle/focus/resume) failures only hit `console.error`; with no small model configured this logs on every idle tick instead of notifying once
- [medium] voice/src/overlay.ts:212-213 — empty `catch` silently drops partial-transcription failures (verified)
- [medium] workers/src/store.ts:156-160 — dead ENOENT/ENOTDIR branch and fallthrough both return `undefined`; every read error (EACCES and others) is swallowed
- [medium] workers/src/actions.ts:111-115 — catch converts every spool read failure into "No stream captured"; EACCES hides as a missing stream

### State

- [medium] workers/src/store.ts:204,211 — module-level `persistQueues` / `removedWorkers` maps leak across Pi instances and tests; move to per-instance state or document as deliberate with a test reset
- [medium] messenger/src/store.ts:479 — module-level `caseProbeCache` memo leaks across instances; pass the probe result in from the composition root or exempt it in a comment

### Structure

- [medium] voice/voice.ts:79-120 — composition root re-exports ~30 internal symbols (barrel pattern); tests already import `src/` modules directly
- [medium] synthetic/synthetic.ts:27-28 — root re-exports internal symbols consumed only by the test; point the test at `src/` and delete the re-exports
- [medium] neuralwatt/neuralwatt.ts:34-35 — root re-exports five internal symbols; the test also imports `src/flex.ts` directly
- [medium] ask-user/ask-user.ts — no `// --- ` section comments (verified)
- [medium] ask-user/ask-user.ts:148-272 — `askWithDialogs`, `parseMultiSelectAnswer`, `formatNumberedOptions`, `extractQuestions`, `safeQuestions` live in the composition root; move to `src/`
- [medium] ask-user/src/result.ts:83-97 — `textComponent` reimplements `wrapToolText` from lib/tool-renderer
- [medium] workers/src/provision/hook.ts:6 — cross-extension src import `worker-sandbox/src/client.ts`; the only such import in the repo
- [medium] worker-sandbox/src/client.ts:1-8 — consumed by a second extension (workers); promote `client.ts` + `policy.ts` to `lib/` or record an exception (preserve the `import.meta.url`-relative broker spawn at client.ts:224)
- [medium] background-jobs/src/registry.ts:90 — `formatStatusText` exported but never called (verified); the extension has no `ctx.ui.setStatus` fallback, so the widget-first rule is unmet here too — wire it via `formatStatusLine` and add the key to the status-bar skip list, or delete the helper
- [medium] background-jobs/background-jobs.ts:303 — `err()` helper sits after `// --- Extension ---`; move it up under `// --- Helpers ---`
- [medium] approval-mode/src/dialog.ts:88 — bespoke approval dialog (defensible: Enter must not mean approve); record the deviation in a comment/README or extend lib/input-modal with a safe-default variant
- [medium] context/context.ts:31-38 — non-TUI modes send a transcript message with `triggerTurn: false`; the only such call in the repo; deliberate and tested — drop it or add a documented carve-out to the extension-development skill
- [medium] status-bar/status-bar.ts:9-12 — module header still says footer line 1 shows "model/provider, thinking level (color-coded, with a live activity dot)"; the model/thinking moved to the editor title (verified)

### Duplication within one extension

- [medium] goal/src/formatting.ts:3-8 — `formatTokens` reimplements `lib/model-picker.ts` `formatTokenCount` with different rounding (goal: 1500 → "2k"; lib: "1.5k")
- [medium] context/src/view.ts:17 — `formatTokenCount` reimplements `lib/model-picker.ts` (output drift: lib renders `1m`, local renders `1.0m`)
- [medium] code-search/src/results.ts:15-17 — `stripGithubPrefix` duplicates client.ts:31-33; export once from client.ts

---

## 2. Open README / doc gaps

- [medium] synthetic/README.md:3 — intro claims "dynamic model discovery" (verified); lines 55-69 — model table omits the `hf:` prefix the code registers; line 73 — "Startup staleness check" section has no body
- [medium] clear/README.md:25 — says the handler runs `ctx.ui.confirm()` (verified); the code calls `confirmModal` (framed modal in TUI, `ctx.ui.confirm` only as non-TUI fallback)
- [low] neuralwatt/README.md — "Pi APIs Used" table omits `pi.on("before_provider_request")` (neuralwatt.ts:93) and `pi.events.emit(FLEX_EVENT)` (neuralwatt.ts:50) (verified)
- [low] worker-blocker/README.md:7 + worker-blocker.ts:7 — "as an `workers_blocker` marker" → "as a" (verified)
- [low] approval-mode/README.md — the `--worker-readonly` flag (approval-mode.ts:41) is undocumented (verified)
- [low] test/extensions/session-recap.test.ts:665 — comment says "< 30 words"; the threshold is 50 (verified)

---

## 3. Open code findings — low

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

---

## 4. lib/ extractions (completed)

All 11 candidates now use shared helpers where behavior matches. The workers process runner remains separate: it streams to files and kills a detached process group, unlike one-shot captured commands.

1. `lib/exec.ts` — autoresearch measurement and mission verification. The workers runner stays separate for the reason above.
2. `lib/fetch-timeout.ts` — Synthetic and Neuralwatt catalog/quota requests, Neuralwatt Flex, code-search, and web-search.
3. `lib/provider-auth.ts` — Synthetic and Neuralwatt API keys and request headers.
4. `lib/provider-quota.ts` — Synthetic and Neuralwatt quota requests.
5. `lib/provider-models.ts` — Synthetic and Neuralwatt static model lists.
6. `lib/transcript-prompt.ts` — handoff and session-recap prompt lines.
7. `writeTextAtomic` in `lib/json-atomic.ts` — messenger JSONL mailbox rewrites.
8. `lib/overlay-options.ts` — todos, context, and background-jobs panels.
9. `lib/settle-once.ts` — ask-user and approval-mode abortable dialogs.
10. `lib/arrow-keys.ts` — ask-user and background-jobs raw arrow keys.
11. `createModelConfigFlow` in `lib/model-picker.ts` — small-model and worker-model configuration.

The original candidate list described code before extraction. The audit history remains in git.

Not recommended for extraction: budget/iteration bookkeeping (autoresearch/missions/goal) — persistence and semantics differ per domain.

---

## 5. Verified clean across the audit

One discoverable root entrypoint per extension; async default exports everywhere; direct Pi registrations visible in roots; closure-scoped state in most extensions; no non-null assertions; no `homedir()` or `.pi` literals outside the conventions allowlist; no src-to-root imports; no import cycles; messenger correctly uses presence-shards/file-lock/writeJsonAtomic; codex-image and worker-model correctly use writeJsonAtomic; status-bar and voice correctly use editor-factory layering; missions/autoresearch/goal satisfy the widget-first rules.
