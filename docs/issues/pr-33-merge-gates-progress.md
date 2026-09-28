# PR #33 merge-gate work

- Status: six merge gates complete; other review findings remain open
- Source review: [pr-33-review-findings.md](pr-33-review-findings.md)
- Scope: Approval Mode dialog, four reported merge gates, and the worker-ID path escape promoted from the majors.

Work in this order. Record the test result beside each item before marking it done.

1. [x] Approval dialog: use the shared framed modal in terminal mode, keep the full command reviewable, and preserve the native selector in RPC mode. The default is Block; long commands require scrolling to the end. Focused tests: 30/30. Typechecks and the single-extension validator pass.
2. [x] Executable hooks: cover the missing `fd`, `find`, and Git forms. A low Jev risk score still requires confirmation. Unit tests pass; the 45-case synthetic calibration passed twice. It sent command strings as data and executed none. [Remaining limits](approval-execution-hooks.md).
3. [x] Spawn failure: finalize the worker as failed and settle `done` when no child exists. Four targeted tests pass, including a new delegate that uses the freed slot without cancellation.
4. [x] Cancellation: save `cancelled by user` for a cancelled worker and keep timeout errors for actual timeouts. Both targeted tests pass; the response and saved record agree.
5. [x] Sandbox boundary: four tests run the real broker and tool child with a stub sandbox manager. They cover framing, binary output, errors, timeout, cancellation, and child process-group kills. Five convention tests now include `.mjs` and parse a JavaScript violation. The stub does not test actual sandbox enforcement.
6. [x] Worker ID: validate raw IDs at the tool entry and each artifact or worktree path. Six targeted tests pass, including the record-missing removal path and a trailing-newline ID. A mismatched record ID is ignored.

Verification: `npm run format` made no further changes. `npm run check` passed Biome, both typechecks, 26 extension validations, and 1,429 tests. The synthetic approval calibration passed 45/45 twice; it did not execute the example commands.

The other findings in the source review remain open after this first pass.
