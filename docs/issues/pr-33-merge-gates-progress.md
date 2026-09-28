# PR #33 merge-gate work

- Status: four merge gates, finding 7, majors 5/6/8, and this session's cross-cutting themes complete; the docs/nit batch and remaining themes stay open
- Source review: [pr-33-review-findings.md](pr-33-review-findings.md)
- Scope: Approval Mode dialog, four reported merge gates, the worker-ID path escape, and majors 5, 6, 8.

Work in this order. Record the test result beside each item before marking it done.

1. [x] Approval dialog: use the shared framed modal in terminal mode, keep the full command reviewable, and preserve the native selector in RPC mode. The default is Block; long commands require scrolling to the end. Focused tests: 30/30. Typechecks and the single-extension validator pass.
2. [x] Finding 1 (executable hooks): cover the missing `fd`, `find`, and Git forms. A low Jev risk score still requires confirmation. Unit tests pass; the 45-case synthetic calibration passed twice. It sent command strings as data and executed none. [Remaining limits](approval-execution-hooks.md).
3. [x] Finding 2 (spawn failure): finalize the worker as failed and settle `done` when no child exists. Four targeted tests pass, including a new delegate that uses the freed slot without cancellation.
4. [x] Finding 3 (cancellation): save `cancelled by user` for a cancelled worker and keep timeout errors for actual timeouts. Both targeted tests pass; the response and saved record agree.
5. [x] Finding 4 (sandbox boundary): four tests run the real broker and tool child with a stub sandbox manager. They cover framing, binary output, errors, timeout, cancellation, and child process-group kills. Five convention tests now include `.mjs` and parse a JavaScript violation. The stub does not test actual sandbox enforcement.
6. [x] Finding 7 (worker ID): validate raw IDs at the tool entry and each artifact or worktree path. Six targeted tests pass, including the record-missing removal path and a trailing-newline ID. A mismatched record ID is ignored.
7. [x] Finding 5 (voice TTS cache): build the sherpa engine per model instead of one unkeyed slot. A Kitten-to-Supertonic switch failed before the fix (one `createAsync` call, expected two) and passes after it. The full voice suite: 104/104.
8. [x] Finding 6 (reservation data shape): validate the map and each claim on read, so valid JSON with a wrong shape fails closed instead of turning enforcement off. Eight invalid shapes covered; three targeted tests pass.
9. [x] Finding 8 (neuralwatt README): add DeepSeek V4 Flash (Speed) and DeepSeek V4.1 Flash to the introduction, catalog table, and thinking-level table. The parity test passed after the update.
10. [x] Cross-cutting dedup: one `isNodeError` in `lib/errors.ts` replaces eight copies, one `THINKING_LEVELS` in `lib/thinking-levels.ts` serves three consumers, `findNewestCustomEntry` in `lib/session-utils.ts` replaces two hand-rolled scans, worker-model config writes route through `writeJsonAtomic` with a `mode` option so the owner-only mode survives, and mailbox validation reuses `assertValidAgentName`. New tests: 4 errors, 3 thinking levels, 4 newest-entry.
11. [x] Cross-cutting error swallowing: autoresearch pending clear, worker-extensions config read, worker-blocker spool mkdir, and the missions listing now swallow `ENOENT` only and surface every other code. Each fix had a failing-first test (EISDIR, EISDIR, EACCES, ENOTDIR).

Verification: `npm run format` made no further changes. `npm run check` passed Biome, both typechecks, 26 extension validations, and 1,449 tests. The synthetic approval calibration passed 45/45 twice; it did not execute the example commands.

The docs and nit batch in the source review, plus the themes outside this share, remain open.
