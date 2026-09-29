# Consistency audit — 2026-02

Nine read-only review workers audited all 27 extensions (~26,000 lines of TypeScript) against AGENTS.md, the extension-development / extension-structure / shared-helpers skills, and the root README. Baseline at audit time: 27/27 extensions validate, 1535/1535 tests pass (`npm run check:ci`).

Totals: **145 findings — 29 high, 49 medium, 67 low.** 12 extensions have no high findings.

Severity: high = MUST/MUST-NOT violation or README contradicts code; medium = convention drift or proven duplication; low = polish.

Findings per extension:

| Extension | H | M | L | Total |
|---|---|---|---|---|
| workers | 1 | 3 | 7 | 11 |
| voice | 5 | 2 | 5 | 12 |
| btw | 4 | 3 | 4 | 11 |
| synthetic | 1 | 8 | 2 | 11 |
| status-bar | 2 | 4 | 2 | 8 |
| context7 | 4 | 2 | 2 | 8 |
| neuralwatt | 2 | 5 | 2 | 9 |
| session-recap | 1 | 2 | 6 | 9 |
| goal | 0 | 3 | 3 | 6 |
| web-search | 3 | 1 | 2 | 6 |
| background-jobs | 1 | 1 | 4 | 6 |
| autoresearch | 1 | 1 | 5 | 7 |
| ask-user | 0 | 3 | 2 | 5 |
| messenger | 0 | 2 | 3 | 5 |
| codex-image | 0 | 0 | 4 | 4 |
| context7/code-search/web-search cross | — | — | — | — |
| code-search | 1 | 2 | 1 | 4 |
| context | 1 | 2 | 1 | 4 |
| approval-mode | 0 | 1 | 2 | 3 |
| missions | 0 | 0 | 3 | 3 |
| worker-model | 0 | 1 | 2 | 3 |
| handoff | 1 | 0 | 1 | 2 |
| clear | 0 | 1 | 1 | 2 |
| worker-sandbox | 1 | 1 | 0 | 2 |
| small-model | 0 | 0 | 1 | 1 |
| worker-blocker | 0 | 0 | 1 | 1 |
| tool-style | 0 | 0 | 1 | 1 |
| todos | 0 | 1 | 0 | 1 |

---

## 1. High-severity findings

### Docs name commands that do not exist (colon forms are real)

- [high] README.md:36 — says "Switch providers mid-session with `/websearch`"; registered command is `websearch:select` (web-search.ts:293)
- [high] README.md:39 — status-bar row says "Toggle with `/statusbar`"; code registers `statusbar:toggle` (status-bar.ts:532); extension README and shared-helpers skill both say `/statusbar:toggle`
- [high] README.md:42 — voice row names `/voice-speak`; registered command is `/voice:speak` (voice.ts:459); row also says "`/voice` opens one settings modal" — `/voice` opens the dictation overlay; settings live at `/voice:settings` (voice.ts:415-423)
- [high] README.md:30 — synthetic row documents `/synthetic-models` and `/synthetic-quota`; code registers `synthetic:models` and `synthetic:quota` (synthetic.ts:59,69)
- [high] README.md:31 — neuralwatt row documents `/neuralwatt-models`, `/neuralwatt-quota`, `/neuralwatt-flex`; code registers `neuralwatt:models`, `neuralwatt:quota`, `neuralwatt:flex` (neuralwatt.ts:110,138,148)
- [high] extensions/voice/README.md:155 — "Use `/voice` to switch models" contradicts code (`/voice` opens the overlay; settings at `/voice:settings`); same wrong-command references at lines 153, 171, 184, 274

### READMEs contradict code

- [high] extensions/voice/README.md:291 — API table claims `ctx.ui.setStatus()` shows speech state; voice never calls `setStatus`, it uses `ctx.ui.setWidget` (src/summary.ts:163,166)
- [high] extensions/session-recap/README.md:34 — README says "at least 30 assistant words"; code requires `assistantWords >= 50` (src/transcript.ts:85); stale test comment agrees with the README at test/extensions/session-recap.test.ts:634
- [high] extensions/autoresearch/README.md:38 — README says "manual tool actions still work anywhere" for non-owner sessions; `run`, `log`, and `stop` throw for non-owners (src/store.ts:171-176, wired at autoresearch.ts:100-104; asserted at test/extensions/autoresearch.test.ts:913). Only `status` works anywhere
- [high] extensions/code-search/README.md:50,70 — says the client "reads the full body once the stream terminates" and "stream is read to completion"; code stops at the `event: done` tail check and cancels the reader (src/client.ts:138-159; locked by test/extensions/code-search.test.ts:348)
- [high] extensions/worker-sandbox/README.md:44 — Pi APIs table says `pi.on("tool_call")` performs the tool overrides; the code registers overriding tools via `pi.registerTool` (worker-sandbox.ts:41-58); no `tool_call` handler exists
- [high] extensions/status-bar/README.md:70 — claims "No module-level mutation, no global map. All state is per-instance"; src/editor.ts:166-190 keeps a process-global `Symbol.for("status-bar.prompt-history-by-session")` map on `globalThis`
- [high] README.md:30 + extensions/synthetic/README.md:3 — "dynamic model discovery" contradicts the shipped design: a hardcoded static catalog with a startup staleness check and no runtime refresh (synthetic.ts:7-9,35-41; synthetic README line 51 and 89 agree with the design, not the intro)
- [high] README.md:31 — neuralwatt row lists model families removed from the catalog (Kimi K2.5/K2.6, Qwen3.5); src/models.ts:304-306 deprecates them. Current families: DeepSeek V4/V4.1 Flash, Gemma 4, GLM-5.2/5.3, Kimi K2.7/K3, Qwen3.6/3.8
- [high] extensions/workers/README.md:64 — says the `workers:state` payload is `{ running: <n> }` "for future consumers such as the status bar"; payload also carries `workerCostUsd` and `workerTokens` (workers.ts:244-248) and the status bar consumes the event now (status-bar/src/constants.ts:168-171, src/footer.ts:205)
- [high] README.md:41 + extensions/clear/README.md:25 — clear row says discard confirmation is handled by `/new`; `/clear` first asks its own "Start a fresh session?" via `confirmModal` (clear.ts:29-35); the README bullet claims `ctx.ui.confirm()` but the code calls `confirmModal` (framed modal in TUI, `ctx.ui.confirm` only as non-TUI fallback)

### Shared-helpers MUST violations (duplicate implementations)

- [high] extensions/voice/src/config.ts:36-49 — `writeVoiceConfig` hand-rolls a temp-file-plus-rename atomic JSON write; `lib/json-atomic.ts` `writeJsonAtomic` is the mandated helper (supports `mode: 0o600` and adds fsync)
- [high] extensions/context7/src/cache.ts:105-112 — `atomicWriteJson` reimplements `writeJsonAtomic`, weaker (no fsync, no parent-dir creation)
- [high] extensions/voice/src/summary.ts:9-37 — `findLatestAssistantText` hand-rolls `typeof content === "string"` / `Array.isArray` filtering while walking `getBranch()` (summary.ts:115); must use `lib/session-utils.ts` `extractText`
- [high] extensions/btw/src/thread.ts:121-131 — hand-rolled `extractText` duplicates `lib/session-utils.ts`
- [high] extensions/handoff/src/transcript.ts:8-19 — hand-rolled `extractText` duplicates `lib/session-utils.ts`
- [high] extensions/context7/src/renderers.ts:18-22 + 10 more sites — hand-rolled one-line status components instead of `createToolStatus` from lib/tool-renderer (sites: 18-22, 29-31, 88-91, 109-111, 118-120, 158-161, 169-172, 190-192, 199-201, 242-245, 253-257)
- [high] extensions/btw/src/model.ts:18 — `globalSmallModelDisplay()` calls `loadSmallModelConfig()` directly (used at btw.ts:308, overlay.ts:312,314); consumers must call `resolveSmallModel` and nothing else
- [high] extensions/btw/src/handoff.ts:65-79 — `completeSimple` options pass apiKey/headers/env/reasoning but no `signal`; a summarize call is uncancellable on shutdown; canonical pattern passes `ctx.signal` (handoff/src/summary.ts:73)
- [high] extensions/workers/workers.ts:244-257 — widget-first rule broken: no `ctx.ui.setStatus` fallback and no status key; `publish()` only emits `workers:state` and sets the strip widget; `extensions/status-bar/src/constants.ts:127-142` skip list has no workers key. Missions and autoresearch comply (missions.ts:75, autoresearch.ts:63)

### Real bugs

- [high] extensions/web-search/web-search.ts:301-306 — the `web_fetch` generic catch returns `details: { url }` without `isError: true`, while every sibling failure path sets it (lines 160, 180, 216, 264) and `renderFetchResult` keys error styling solely off `details.isError` (src/rendering.ts:75); failed fetches render as success lines. Tests at test/extensions/web-search.test.ts:1134,1153 assert content only
- [high] extensions/goal/goal.ts:110-118 — `pauseGoal` calls `ctx.ui.notify` with no `hasUI` guard and is reached from `agent_end` (lines 241, 251, 263) and `message_end` (284); `goal.ts:236` completion notify is likewise unguarded; sibling precedent guards the identical case (autoresearch/src/loop.ts:64-70,90-95)
- [high] extensions/status-bar/status-bar.ts:475 — `pi.events.on(FLEX_EVENT, ...)` is registered inside the `session_start` handler, so listeners stack on every session start with no matching `off`; the other four subscriptions register at load time (status-bar.ts:151,170,178,189)
- [high] extensions/context7/src/cache.ts:82 — module-level `let mutationQueue` leaks across Pi instances; the index read-modify-write in `putResolveCache`/`putDocCache` (cache.ts:355-376, 414-440) has no cross-process guard, so two Pi sessions can clobber `all.json`; use `withFileLock` (lib/file-lock.ts)
- [high] extensions/autoresearch/src/init.ts:76-88 — config check-then-`saveConfig` cycle is not locked; two concurrent inits can both pass the check and clobber each other's campaign; `stopConfig` is lock-protected, init is not
- [high] extensions/session-recap/session-recap.ts:146-148 — the resume recap `setTimeout` is untracked; `session_shutdown` within 300 ms leaves the callback firing on a stale ctx

---

## 2. Medium findings

### State and lifecycle

- [medium] extensions/workers/src/store.ts:204,211 — module-level mutable `persistQueues` and `removedWorkers` maps leak across Pi instances and tests, never cleared; move to per-instance state or document as deliberate with a test reset
- [medium] extensions/messenger/src/store.ts:479 — module-level mutable `caseProbeCache` leaks across instances (deliberate memo, not exempted in a comment); pass the probe result in from the composition root
- [medium] extensions/context7/context7.ts:44,83,107,129,166,178,199,234 — five `} as any` result casts plus `params as X` casts; type as `AgentToolResult` and drop the casts
- [medium] extensions/context7/src/renderers.ts:8-11 — `renderResult` params typed `any` while types/pi.d.ts:230-242 declares `AgentToolResult`/`ToolRenderResultOptions`/`Theme`/`ToolRenderContext`

### Errors swallowed or mislabeled

- [medium] extensions/btw/src/handoff.ts:85 — `catch { return null; }` swallows the summarize failure; the caller shows a generic warning and the cause is lost
- [medium] extensions/btw/src/handoff.ts:52 — `runSummarize` ignores `_instructions`; `/btw:summarize <instructions>` never steers the summary prompt
- [medium] extensions/session-recap/src/engine.ts:128 — background failures only hit `console.error`; with no small model configured this logs on every idle tick instead of notifying once
- [medium] extensions/voice/src/overlay.ts:212-213 — empty `catch` silently drops partial-transcription failures
- [medium] extensions/workers/src/store.ts:156-160 — dead ENOENT/ENOTDIR branch and fallthrough both return `undefined`; every read error (EACCES and others) is swallowed
- [medium] extensions/workers/src/actions.ts:111-115 — catch converts every spool read failure into "No stream captured"

### Structure

- [medium] extensions/voice/voice.ts:79-120 — composition root re-exports ~30 internal symbols (barrel pattern); tests already import `src/` modules directly
- [medium] extensions/synthetic/synthetic.ts:27-28 — root re-exports internal symbols consumed only by the test; point the test at `src/` and delete the re-exports
- [medium] extensions/neuralwatt/neuralwatt.ts:34-35 — root re-exports five internal symbols; test also imports `src/flex.ts` directly, proving redundancy
- [medium] extensions/ask-user/ask-user.ts — no `// --- ` section comments (constants at lines 15-17 unmarked)
- [medium] extensions/ask-user/ask-user.ts:148-272 — substantial implementation (`askWithDialogs`, `parseMultiSelectAnswer`, `formatNumberedOptions`, `extractQuestions`, `safeQuestions`) lives in the composition root; move to `src/`
- [medium] extensions/ask-user/src/result.ts:83-97 — `textComponent` reimplements `wrapToolText` from lib/tool-renderer
- [medium] extensions/workers/src/provision/hook.ts:6 — cross-extension src import `worker-sandbox/src/client.ts`; the only such import in the repo; structure skill routes shared code through `lib/`
- [medium] extensions/worker-sandbox/src/client.ts:1-8 — now consumed by a second extension; promote `client.ts` + `policy.ts` to a shared module or record an exception (preserve the `import.meta.url`-relative broker spawn at client.ts:224)
- [medium] extensions/background-jobs/src/registry.ts:90 — `formatStatusText` exported but never called; extension has no `ctx.ui.setStatus` call; widget-first rule wants a `formatStatusLine` fallback or the dead helper removed
- [medium] extensions/background-jobs/background-jobs.ts:303 — `err()` helper sits after `// --- Extension ---`; skill orders helpers before extension
- [medium] extensions/approval-mode/src/dialog.ts:88 — bespoke approval dialog (defensible: Enter must not mean approve); record the deviation in a comment/README or extend lib/input-modal
- [medium] extensions/context/context.ts:31-38 — non-TUI modes send a transcript message with `triggerTurn: false`; the only such call in the repo; skill says no fallback console output in rpc/json/print; deliberate (comment at context.ts:44-49, tested at context.test.ts:384) — drop it or add a skill carve-out
- [medium] extensions/status-bar/status-bar.ts:5-12 — module header still describes model/thinking + activity dot on line 1; current footer moved those to the editor title (src/footer.ts:146-148; test asserts model absence)

### DRY (proven 2+ consumers)

- [medium] extensions/autoresearch/src/measure.ts:87-118 — `runCommand` duplicates `missions/src/actions.ts:79-182` exec-with-timeout; `workers/src/runner.ts` has a third variant
- [medium] extensions/synthetic/src/auth.ts:3-19 — byte-identical to `neuralwatt/src/auth.ts:3-19` except provider name and env var
- [medium] extensions/synthetic/src/models.ts:259 — `formatModelList` byte-identical to `neuralwatt/src/models.ts:410`
- [medium] extensions/synthetic/src/quota.ts:5-25 — `fetchQuota` differs from `neuralwatt/src/quota.ts:5-25` only in endpoint and response type
- [medium] extensions/synthetic/src/catalog.ts:15-27 — AbortController + 15 s timeout + signal chaining duplicated five times across both providers (neuralwatt catalog/quota/flex, synthetic catalog/quota); code-search (client.ts:168-186) re-implements the same shape that web-search shares as `createTimeoutController` (web-search/src/http.ts:11-26)
- [medium] extensions/worker-model/src/picker.ts:10-42 + src/config.ts:12-63 — near line-for-line duplication of `small-model/src/picker.ts` and `small-model/src/config.ts`; extract a shared `selectAvailableTextModel`/config-command helper into `lib/model-picker.ts`
- [medium] extensions/session-recap/src/transcript.ts:51-62 — `User:`/`Assistant:`/`Result(name):` formatting with 1200/400 caps duplicates `handoff/src/transcript.ts:37-46` line for line; extract a shared transcript-to-prompt formatter into `lib/`
- [medium] extensions/todos/src/panel.ts:17 — `OVERLAY_OPTIONS` byte-identical to `context/src/view.ts:183` and inlined at `background-jobs/src/jobs.ts:54`; promote one constant to lib
- [medium] extensions/handoff (cross with session-recap) — see transcript formatter above
- [medium] extensions/voice — hand-rolled atomic write (see high) 
- [medium] extensions/messenger/src/store.ts:333-335, 373-375 — `markRead` and `quarantineMalformedLocked` hand-roll the temp-file-plus-rename atomic write for JSONL (not JSON, so `writeJsonAtomic` does not fit); add a `writeTextAtomic` variant to `lib/json-atomic.ts`
- [medium] extensions/ask-user/src/dialog.ts:541-548 + extensions/background-jobs/src/jobs.ts:158-164 — two extensions hand-roll arrow-key byte matching; shared key-matching helper now has two consumers
- [medium] extensions/ask-user.ts:106-146 + extensions/approval-mode/src/dialog.ts:158-181 — `ui.custom` settle-once + abort-listener pattern duplicated; qualifies for `lib/`
- [medium] extensions/goal/src/formatting.ts:3-8 — `formatTokens` reimplements `lib/model-picker.ts:25-30` `formatTokenCount` with different rounding
- [medium] extensions/context/src/view.ts:17 — `formatTokenCount` reimplements `lib/model-picker.ts:25` (output drift: lib renders `1m`, local renders `1.0m`)
- [medium] extensions/code-search/src/results.ts:15-17 — `stripGithubPrefix` duplicates client.ts:31-33 within one extension; export once

### README accuracy (medium/low)

- [medium] extensions/synthetic/README.md:55-69 — model table omits the `hf:` prefix the code registers and `/synthetic:models` prints; row 67 shortens the Nemotron id; usage example at line 18 uses `hf:`
- [medium] extensions/web-search/README.md:159-170 — Docker snippet writes `secret_key: "$(openssl rand -hex 32)"` inside a quoted heredoc, so the literal string becomes the secret; lines 159 and 163 create `searxng/` twice
- [medium] extensions/worker-model/README.md:34 — says `PI_WORKER_MODEL` "disables `/worker-model` writes"; code blocks the entire command including read-only `status` (worker-model.ts:25-33)
- [medium] extensions/status-bar/README.md:59,71 — describes editor factory "capture/restore"; code uses lib/editor-factory layering (install priority 0 at status-bar.ts:252, remove at :289) with a 0-tick re-check race guard (status-bar.ts:456-467)
- [low] extensions/small-model/README.md:33 — shows literal `~/.pi/agent/small-model.json`; path resolves via `agentConfigPath` and follows `PI_CODING_AGENT_DIR`
- [low] extensions/handoff/README.md:77 — documents only `/smallmodel`; `PI_SMALL_MODEL`/`PI_SMALL_MODEL_THINKING` overrides apply via `resolveSmallModel` but are undocumented
- [low] extensions/session-recap/README.md:79 — says recap clears on next input only; code also auto-dismisses after 120 s (src/constants.ts:13, src/widget.ts:45-48); same line says "uses `setWidget()`"; code publishes through `setStripWidget` (src/widget.ts:8-16)
- [low] extensions/session-recap/README.md:60-75 — WeakMap state table omits `autoDismissTimer` (src/types.ts:38, src/widget.ts:12-16)
- [low] extensions/session-recap/README.md:77 — says staleness check is leaf-based; code compares the last message entry id (src/engine.ts:117, src/transcript.ts:23-27)
- [low] extensions/goal/README.md:97 — cites "the `plan` extension"; no `plan` extension exists
- [low] extensions/goal/README.md:101-102 — says replacement/reset "trigger a `ui.confirm()` dialog"; TUI mode renders `confirmModal` from lib/input-modal
- [low] README.md:26 — goal row says "`/goal` command with pause/resume/clear"; the command is `/goal:reset` (goal.ts:478); no `/goal:clear` exists
- [low] extensions/autoresearch/README.md:14 — state-file list omits `untracked-snapshot.json` (read/written by init/run/log/stop: src/store.ts:259-276, src/experiments.ts:40,77)
- [low] extensions/autoresearch/README.md:34 — table says `autoresearch:state` publishes "for the status bar"; nothing subscribes
- [low] extensions/context7/README.md:112-113 — documents cache paths with a `cache/` segment the code does not use (cache.ts:134-155 join directly on `cacheDir`)
- [low] extensions/context7/README.md:128 — claims "only Node.js built-ins (`crypto`, `fs`, `fs/promises`, `os`, `path`)"; code never imports `node:os` and does import `@earendil-works/pi-tui` and lib/paths.ts
- [low] extensions/context7/README.md:134,156 — states config path only as `~/.pi/agent/context7.json`; resolves via `agentConfigPath` (honors `PI_CODING_AGENT_DIR`)
- [low] extensions/context7/README.md:172 — typo "How long to cached fetched documentation"
- [low] extensions/code-search/README.md:59 — in-progress state described as "dim"; renderer uses theme color `"warning"` (renderer.ts:20-21)
- [low] extensions/messenger/README.md:8-12 — usage block omits `whoami` and `status` actions (src/schemas.ts:6, src/actions.ts:110-145)
- [low] extensions/worker-blocker/README.md:7 + worker-blocker.ts:7 — "as an `workers_blocker` marker" → "as a"
- [low] extensions/tool-style/README.md:33 — documents only `~/.cache/wal/colors.json`; src/surface.ts:106-112 also honors `PYWAL_CACHE_DIR` and `XDG_CACHE_HOME`
- [low] extensions/neuralwatt/README.md:122-131 — "Pi APIs Used" table omits `pi.on("before_provider_request")` (neuralwatt.ts:93) and `pi.events.emit(FLEX_EVENT)` (neuralwatt.ts:50)
- [low] extensions/synthetic/README.md:73 — "Startup staleness check" section has no body
- [low] extensions/approval-mode/README.md — the `--worker-readonly` flag (approval-mode.ts:37-41) is undocumented

### Missing READMEs (high, with drafts delivered)

- [high] extensions/background-jobs/ — no README; full draft in worker report (tools, wake delivery, spool location via `agentStateDir`, 7-day/200-file retention, widget, `/jobs` panel)
- [high] extensions/context/ — no README; full draft in worker report (`/context` modal contents, estimates vs provider-reported used, design decisions)

---

## 3. Low findings (selected)

- [low] extensions/workers/workers.ts:21 — no `// --- Imports ---` section header
- [low] extensions/workers/src/store.ts:78,454 — comments in French; translate
- [low] extensions/workers/src/delegate.ts:314 — recomputes `extensionsRoot` already defaulted by worker-extensions.ts
- [low] extensions/workers — `abortDetail`/`abortReason` (runner.ts:573 vs provision/hook.ts:27) and assistant text extraction (runner.ts:218-225 vs format.ts:165-172) duplicated within the extension
- [low] extensions/voice/src/summary.ts:166 — `(tui: any, theme: any)` erases widget component types
- [low] extensions/voice/src/overlay.ts:101 — stray `// 0.5s` comment
- [low] extensions/voice/src/overlay.ts:262-277 — `ctx.ui.custom` rejection skips `cleanup()`; recorder child process and timers leak; wrap in try/finally
- [low] extensions/voice/src/constants.ts:19 — `HOLD_REPEAT_INITIAL_GAP_MS` unused
- [low] extensions/voice/src/transcription.ts:224-231 vs 324-332 — offline decode + anti-loop sequence repeated; extract one helper
- [low] extensions/btw/btw.ts:144,165,194,228,278 — the same 8-line thread-reset block repeats 5×; extract one closure helper
- [low] extensions/btw/btw.ts:5 — header comment says rows framed by hand with `frameLine`; overlay.ts:217 uses `renderModalFrame`
- [low] extensions/btw/src/transcript.ts:202 — inline dynamic `import(...)` type; move to top-level `import type`
- [low] extensions/btw/src/thread.ts:61-66 — identical assistant/toolResult branches in `cloneThreadState`
- [low] extensions/btw/src/handoff.ts:80 — inline `12000` cap; name a constant
- [low] extensions/goal/README.md — see medium/low list above
- [low] extensions/missions/src/actions.ts:141-148 — corrupt active-mission file degrades to "no active mission" with `console.error` only; notify "warning" when UI exists
- [low] extensions/missions/src/actions.ts:41 — `MissionToolParams = Record<string, any>`; use `unknown` like autoresearch
- [low] extensions/missions/src/format.ts:14,21 — `statusText`/`progressText` exported but module-private in practice
- [low] extensions/autoresearch/src/types.ts:88-89 — two stacked JSDoc comments on `spread`; first contradicts the no-noise-floor rule in src/stats.ts:8-10
- [low] extensions/autoresearch/src/format.ts:16-19,87 — status icon/color constants and `statusText` exported but unimported
- [low] extensions/messenger/src/watcher.ts:42,61-62 — two empty catches swallow watcher failures (comments document the fallback); add a debug log
- [low] extensions/messenger/messenger.ts:19 — imports lack the `// --- Imports ---` header
- [low] extensions/worker-model/src/config.ts:73-79 — `configuredWorkerModelLabel` has no caller and swallows config errors
- [low] extensions/background-jobs/src/runner.ts:136 — `appendFile(job.spoolPath as string, ...)` cast; assign a typed local
- [low] extensions/background-jobs/src/jobs.ts:78-79 — `options.jobId as number` cast twice around `Number.isFinite`
- [low] extensions/background-jobs/src/format.ts:43 + src/jobs.ts:151,315 — status-to-mark mapping duplicated with `statusColor` separate; one shared status table
- [low] extensions/approval-mode/src/jev.ts:5 + src/policy.ts:3 — `// --- Types ---` precedes `// --- Constants ---`; swap
- [low] extensions/status-bar/src/editor.ts:157-160 — `PolishedEditor` doc comment stranded ~55 lines above its class by the section comment
- [low] extensions/status-bar/src/editor.ts:190-200 — per-session prompt-history map grows unbounded per session; bound or prune on `session_shutdown`
- [low] extensions/codex-image/codex-image.ts:1-2 — runtime `typebox` import after `import type ... from "pi"`; swap
- [low] extensions/codex-image/codex-image.ts:24-26 — constants under `// --- Extension ---`; add `// --- Constants ---`
- [low] extensions/codex-image/codex-image.ts:33 — hardcodes `5`; import `MAX_INPUT_IMAGES` from src/output.ts:29
- [low] extensions/codex-image/codex-image.ts:56-90 — `generate_image` ships no `renderResult`; consider lib/tool-renderer
- [low] extensions/web-search/src/html.ts:36-45 — `decodeHtmlEntities` replaces `&amp;` first, so double-encoded entities decode twice
- [low] extensions/web-search/src/rendering.ts:13 — pointless `wrapMultilineText = wrapToolText` alias
- [low] extensions/synthetic/src/catalog.ts:31-35 + neuralwatt/src/catalog.ts:33-37 — errors return `[]` silently; network failure indistinguishable from in-sync catalog
- [low] extensions/ask-user/ask-user.ts — see medium list

---

## 4. lib/ extraction candidates (proven 2+ consumers)

1. Exec-with-timeout runner — autoresearch/src/measure.ts, missions/src/actions.ts, workers/src/runner.ts
2. Fetch-with-timeout controller — synthetic (3 sites), neuralwatt (3 sites), code-search (reuses web-search's `createTimeoutController` shape)
3. Provider API-key resolver — synthetic/src/auth.ts, neuralwatt/src/auth.ts (byte-identical)
4. Quota-fetch skeleton — synthetic/src/quota.ts, neuralwatt/src/quota.ts
5. `formatModelList` — synthetic/src/models.ts:259, neuralwatt/src/models.ts:410 (byte-identical)
6. Transcript-to-prompt formatter — handoff/src/transcript.ts:37-46, session-recap/src/transcript.ts:51-62
7. `writeTextAtomic` for JSONL — messenger/src/store.ts (extend lib/json-atomic.ts)
8. Overlay size options constant — todos/src/panel.ts, context/src/view.ts, background-jobs/src/jobs.ts
9. `ui.custom` settle-once + abort-listener pattern — ask-user, approval-mode
10. Arrow-key matcher — ask-user/src/dialog.ts, background-jobs/src/jobs.ts
11. Model-picker config flow — small-model/src/{picker,config}.ts, worker-model/src/{picker,config}.ts

Not recommended for extraction: budget/iteration bookkeeping (autoresearch/missions/goal) — persistence and semantics differ per domain.

---

## 5. Structural smells

- Cross-extension src import: workers/src/provision/hook.ts imports worker-sandbox/src/client.ts (only such import; promote to lib/ or document exception)
- Root barrels: voice (~30 re-exports), synthetic (3 test-only), neuralwatt (5 test-only)
- Composition-root bloat: ask-user (~125 lines of pure functions in root)

## 6. Verified clean across the audit

One discoverable root entrypoint per extension; async default exports everywhere; direct Pi registrations visible in roots (ask-user implementation placement aside); closure-scoped state in most extensions; no non-null assertions; no `homedir()` or `.pi` literals outside the conventions allowlist; no src-to-root imports; no import cycles; messenger correctly uses presence-shards/file-lock/writeJsonAtomic; codex-image and worker-model correctly use writeJsonAtomic; status-bar and voice correctly use editor-factory layering; missions/autoresearch/goal fully satisfy the widget-first rules.
