# PR #33 review: agentic harness suite

- Category: review findings (merge gates + follow-ups)
- Severity: high (gates 1-4), medium (majors), low (rest)
- Found during: PR #33 third-round review, 2026-09-27
- Status: open
- Scope: 196 files, +30,746/-3,920, 164 commits on `feature/agentic-harness-suite`

Review method: the PR was split into seven chunks and reviewed in parallel (missions+messenger, agents core, provisioning+sandbox, autoresearch+approval-mode, shared lib+infra, modified extensions, docs+skills). Every blocker and major below was re-verified against source in this session. Line numbers refer to the branch tip (`9247378`).

Verdict: **request changes, then merge.** Architecture and convention adherence are strong. No design work remains. The four gates are small, local fixes.

## Merge gates

### 1. Approval gate misses execution hooks

`extensions/approval-mode/src/policy.ts:58-64`

`EXECUTION_HOOKS` has five patterns. Verified gaps:

- `fd --exec`/`--exec-batch`: the pattern matches `-[xX]` only, so the long forms return `false` from `hasExecutionHook`.
- `find -exec`/`-execdir`: no pattern exists.
- `git -c core.pager=<cmd>` / `git -c gpg.program=<cmd>`: only `fsmonitor`, `sshcommand`, `hooks_path`, and `alias.*` are covered.

A Jev score under the allow thresholds (`harm <= 0.15`, `secrets <= 0.2`, `externalChange <= 0.15` in `src/jev.ts:139`) auto-runs these forms with no confirmation. This is the same class as the escapes documented for the old plan-mode allowlist, but the branch deletes that tracking doc; the PR description links to `docs/issues/plan-allowlist-execution-flag-escapes.md`, which does not exist on the branch (`git ls-tree HEAD docs/` lists three files, no `issues/`).

Fix: extend `EXECUTION_HOOKS` with the missing patterns, add `scripts/evaluate-approval-mode.ts` cases for each, and re-open a tracking issue in `docs/issues/` so the class stays recorded.

### 2. Spawn failure leaves a zombie running worker

`extensions/agents/src/runner.ts:712-717`

The spawn IIFE catch sets `spawnError` and returns `undefined as unknown as ChildProcess`. The comment says spawn failures "finalize as failed instead". Nothing finalizes: after `await started` (line 872), only the `SetupHookCancelled` branch runs; a non-abort failure (spool `mkdir`/`open`, ENOSPC) resolves `started` to `undefined`, `close` never fires, `done` never settles, and the record stays `running` while a fire-and-forget delegate holds its slot until reload.

Fix: when `child === undefined && spawnError !== undefined`, call `void finish("failed", spawnError.message)`.

### 3. Cancel is durably mislabeled as timeout

`extensions/agents/src/runner.ts:845-851`

The `close` handler passes `timedOutError` as `errorOverride` on every exit. A user cancel kills the child first (during `killPidTree`), so `close` fires before `cancel()`'s `finish("cancelled")`. `finalizeWorker` (line 342) prefers the override, so a cancelled record stores `"worker exceeded 900s timeout"`.

Fix: pass `timedOut ? timedOutError : undefined` as the override.

### 4. Sandbox boundary processes are untested and outside every gate

`extensions/worker-sandbox/src/broker.mjs`, `src/tool-child.mjs`

Both files are security-critical and plain `.mjs`:

- The entrypoint validator accepts `.ts` only (`lib/validate-extension.ts:14`).
- The conventions AST scan walks `.ts` only (`test/conventions.test.ts:37`).
- The only test that touches the broker mocks `spawn` (`test/extensions/worker-sandbox-client.test.ts`), so framing, timeout kills, group kills, and cancel run only in live sessions.

Fix: add a stdin-driven test that runs `broker.mjs` and `tool-child.mjs` with a stubbed `SandboxManager`.

## Majors

### 5. Stale TTS engine after model switch

`extensions/voice/voice.ts:162` — `ttsEnginePromise ??=` caches one sherpa engine per process; `onTtsModelSelect` (line 430) only updates `activeTtsModelId`. With two sherpa backends now selectable, switching Kitten to Supertonic 3 in `/voice` settings then running `/voice-speak` plays through the previous model's engine with the wrong generation config. Unreachable before this PR (one sherpa model).

Fix: key the cache by model id (like `inflectEnginePromises`), or set `ttsEnginePromise = null` in `onTtsModelSelect`.

### 6. Messenger reservations fail open on wrong-shape JSON

`extensions/messenger/src/store.ts:419` — `JSON.parse(raw) as ReservationMap` has no shape validation. A valid-JSON, wrong-shape file (for example `[]`) yields zero claims, and path-reservation enforcement silently turns off. The function's own comment states the opposite intent.

Fix: verify a plain object with claim-shaped entries; throw naming the path otherwise.

### 7. `workers` tool id is unvalidated before path joins

`extensions/agents/agents.ts:418` — the id is trimmed but never format-checked, then interpolated into `recordPath`, `streamPath`, and `worktreePath` joins. An id like `../x` escapes the state directories.

Fix: reject ids not matching `^w-[A-Za-z0-9-]+$` before any path use.

### 8. neuralwatt README omits two shipped models

`extensions/neuralwatt/README.md:52-67,92-104` — `deepseek-v4-flash-speed` (`src/models.ts:269`) and `deepseek-v4.1-flash` (`src/models.ts:289`) are missing from the pricing table, the thinking-level table, and the header line 7. The README's contract is to mirror the live catalog.

Fix: add both models to all three places, using the values in `src/models.ts`.

## Cross-cutting themes

These repeat across chunks. Fix once in a shared place instead of per-extension.

| Theme | Evidence | Fix |
|---|---|---|
| `isNodeError` copied 9 times | `lib/file-lock.ts:74`, `lib/presence-shards.ts:53`, `lib/small-model.ts:224`, `lib/worker-model.ts:179`, `agents/src/store.ts:133`, `autoresearch/src/store.ts:45`, `messenger/src/store.ts:92`, `missions/src/storage.ts:114` | Export one from a lib module |
| `THINKING_LEVELS` copied 3 times | `lib/small-model.ts:9`, `lib/worker-model.ts:25`, `extensions/small-model/src/constants.ts:5` | Export one set |
| Atomic write hand-rolled | `lib/worker-model.ts:132` `saveWorkerModelConfig` duplicates `lib/json-atomic.ts` (sync vs async) | Route through `json-atomic` |
| Silent error swallowing | `autoresearch/src/pending.ts:89` (unlink), `agents/src/worker-extensions.ts:149` (config read), `worker-blocker.ts:78` (mkdir), `missions/src/storage.ts:238` (readdir) | Swallow `ENOENT` only; surface other codes |
| READMEs document `ctx.ui.setWidget`, code uses the strip | `agents/README.md:65`, `autoresearch/README.md:32`, `missions/README.md:47`, `session-recap/README.md:36,99` | Update tables to `setStripWidget` + `WIDGET_PRIORITY` |
| Stale plan-mode references | `agents/src/provision/types.ts:11`, `.pi/skills/provision/SKILL.md:61`, `todos/README.md:3` | Reword |
| French comments in shipped code | `agents/src/store.ts:26` onward, `agents.ts:602`, `messenger/src/actions.ts:66-70,148-153` | Translate |
| Missing READMEs/sections | No `worker-blocker` section in root README; `worker-blocker` and `worker-sandbox` have no README files | Add them |
| Stale manual gitignore step | `missions/README.md:32` vs automatic `excludeFromGit` (`missions.ts:172`) | Say the exclude is automatic and local |

## Nits

Batch these into one follow-up commit.

- `json-atomic.ts` skips fsync; the doc comment promises more than rename gives.
- `status-bar.ts:327`: `startSmallModelWatch()` calls `stopWorkerModelWatch()`; each start should stop only its own watch.
- `status-bar.ts:534-560`: the `/statusbar:toggle` enable branch never starts either config watch.
- `background-jobs.ts:112-127`: `session_start` clears the registry but never re-publishes the strip entry; a stale "Jobs - 0 running" frame can render after a boundary. Also `pruneSpoolDir` can cut another live session's log (`:127`).
- `autoresearch/src/pending.ts:29-36`: a missing file returns without clearing stale in-memory `state.pending`; a second instance's resolution never unblocks this one.
- `autoresearch/src/measure.ts:191`: keep stages all new untracked files with no `isProjectStatePath` filter; `.pi/sandbox.json` created mid-campaign lands in the experiment commit.
- `autoresearch/src/init.ts:93-95`: a foreign-shape `config.json` reads as absent, so `archiveLog` never runs and the new campaign inherits the old `log.jsonl`.
- `autoresearch/src/store.ts`: config read-modify-write has no `withFileLock`, unlike missions and agents stores.
- `messenger/src/store.ts:227`: `assertValidMailboxName` duplicates `assertValidAgentName` (`identity.ts:54`).
- `messenger/src/store.ts:302`: parsed non-message lines vanish instead of going to quarantine.
- `messenger/src/actions.ts:66` and `session-identity.ts:30`: hand-rolled newest-custom-entry scans; add `findNewestCustomEntry` to `lib/session-utils.ts` and share.
- `runner.ts:882`: `child: child ?? ({} as ChildProcess)` fabricates a process no caller reads.
- `runner.ts:831`: `let resolveDone!:` uses a definite-assignment assertion; AGENTS.md bans `!`.
- `runner.ts:893-894`: `stat` imported only to be voided.
- `actions.ts:226-235`: patch-missing check duplicates `discardWorktree` (`worktree.ts:236-243`); extract one helper.
- `agents/agents.ts:660-672`: `session_shutdown` cancels workers sequentially; four workers block shutdown ~16 s. Use `Promise.allSettled`.
- `provision/carry.ts:114`: skip reasons are recorded but never surfaced; a secret-shaped carry file reports "carry 0" with no reason. Also `carry.ts:8`: the `.env` regex misses `.envrc`.
- `worker-sandbox/worker-sandbox.ts:85`: `user_bash` accepts `options.env` but `tool-child.mjs:29-34` drops it.
- `broker.mjs:198`: a cancel arriving during `wrapWithSandboxArgv` is dropped; the child runs to completion.
- `worker-model/src/config.ts:73`: `configuredWorkerModelLabel` has no callers.
- `tool-child.mjs:48`: `request.model` is never sent by the client.
- `jev.ts:70`: `entries?: unknown[]` parameter is accepted and never used; `evaluate-approval-mode.ts:155-162` builds it.
- `voice/README.md:56,147,151`: Supertonic 3 is advertised as 31-language but generation is pinned to English (`constants.ts:31`); `:171` "both Kitten models" is stale (one Kitten entry).
- `approval-mode/src/{approval-mode,jev,policy}.ts`: missing `// --- Section ---` banners.
- `autoresearch/src/types.ts:92-94`: two stacked doc comments on `spread`; the first contradicts `stats.ts:16`.
- `worker-model/README.md`: implies `PI_WORKER_MODEL_THINKING` alone overrides the file; it applies only with `PI_WORKER_MODEL`.
- `provision/types.ts:8`: doc comment explains `yes/failed/skipped/busy` but not `none`.
- `agents/README.md` Pi APIs table says `ctx.ui.setWidget` (covered by the theme table above).

## What is solid

- Widget strip adoption is complete: all six content widgets publish through `setStripWidget` with one shared priority order; the todos recap-reordering hack is deleted. The strip fixes pi's insertion-order churn with cached children and dispose-on-remove.
- `lib/file-lock.ts` and `lib/presence-shards.ts` are carefully reasoned: claim-and-verify reclamation, mtime refresh through the original handle, EPERM-is-alive. Comments match the code.
- Trusted-channel discipline holds end to end: worker wakes carry ids and status words only; output stays in the spool behind the `workers` tool.
- Carry resists path traversal and secret leakage with tests (`provision-carry.test.ts`); the sandbox is fail-closed on every path (missing policy, dead broker, weak flags).
- Missions and messenger use per-file locks with CAS and explicit timeout/stale invariants; corrupt state fails loudly with paths.
- `test/conventions.test.ts` is an honest AST-based guard with a self-checking allowlist.
- AGENTS.md's new claims about `excludeFromGit` and `isProjectStatePath` callers all verify against real call sites.

## Suggested follow-up order

1. Gates 1-4 (approval hooks, runner finalize x2, broker test).
2. Majors 5-8 (voice cache, reservations shape, id regex, neuralwatt tables).
3. One dedup commit: `isNodeError`, `THINKING_LEVELS`, `findNewestCustomEntry`, atomic write.
4. One docs commit: widget API tables, plan-mode leftovers, voice wording, missing READMEs.
5. Nits batch.
