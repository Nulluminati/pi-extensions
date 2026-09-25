# Conventions repo-walk test times out in sandboxed workers

- Category: test infrastructure (environment sensitivity)
- Severity: minor
- Found during: provisioning field tests, 2026-09-25 — first full `npm run check` runs in provisioned worktree workers
- Status: open (owner decision deferred: bump the cap, gate on environment, or keep as marker)

## Evidence

`test/conventions.test.ts` (the path-conventions test at line 83) walks the repository tree. In a provisioned worktree worker it takes **37.3 s** against vitest's default **10 s** `testTimeout` and fails:

```
Error: Test timed out in 10000ms.
 ❯ test/conventions.test.ts:83:3
```

The same run, re-executed with `PI_WORKER` stripped, still fails — the env leak is not involved. On the host the whole suite finishes in 25 s and this test passes.

Root cause is sandboxfs metadata latency, not the test: the same tree walk (`find node_modules -type f`, 28,202 files) takes **0.124 s on the host and 81.3 s in the sandbox** (~2.9 ms per stat round trip vs ~4 µs). See `sandboxfs-metadata-latency.md` for the full benchmark.

After the git-mount fix (`4399372`) and the worker-env strip, this is the **one remaining failure** in an in-guest `npm run check`.

## Impact

A worker-side `npm run check` can never report zero failures while the 10 s cap stands, so the in-guest run reads red for an environment reason. The failure competes with real regressions for attention.

## Resolution direction

Decide later; no change made:

1. Raise the timeout for this test (or mark it slow) — the walk is slow, not broken.
2. Gate the timeout on environment (generous cap inside a worker, 10 s on host).
3. Leave it failing in-guest as a visible marker of the stat tax.
