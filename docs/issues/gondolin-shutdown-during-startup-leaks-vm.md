# Gondolin VM leaks when shutdown races startup

- Category: bug (resource lifecycle)
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open (partially fixed)

## What is fixed

A shell-probe failure after `VM.create()` now closes the created VM, records the persistent startup error, and fails like create does (`extensions/gondolin/gondolin.ts:121-135`, commit `90c2979`).

## What remains

`session_shutdown` (`gondolin.ts:171-182`) captures only `vm` — which is still `undefined` while boot is in flight — then clears `vmStarting` and returns early. When `VM.create()` resolves afterwards, `startVm` unconditionally assigns `vm = created` (`gondolin.ts:137`). Nobody ever closes that VM.

Interleaving: `session_start` with `--gondolin` → QEMU boot begins (seconds) → user quits → shutdown sees `vm === undefined`, returns → create resolves → `vm = created` with no owner left to close it. A later session in the same process silently reuses the leaked VM.

## Resolution direction

Table row 9's open decision: may shutdown wait for the in-flight `vmStarting` promise to settle (then close the result), or must it return immediately with a shutdown flag that `startVm` checks before assigning `vm`, closing the created VM instead? Either way the created-VM-close path needs a test mirroring the probe-failure test with a deferred `VM.create`.
