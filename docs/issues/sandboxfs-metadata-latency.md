# Sandbox metadata latency taxes every stat-bound tool (sandboxfs round trip)

- Category: performance (sandbox filesystem)
- Severity: important (19x on the full check; affects every sandboxed build, all projects)
- Found during: field benchmark by session swift-otter-4, 2026-09-25
- Status: open (upstream fix requested pattern; local policy adopted)

## Evidence

Same probes, host vs sandboxed worktree worker (`/workspace` = fuse.sandboxfs):

| Probe | Host | Sandbox | Ratio |
|---|---|---|---|
| CPUs | 8 | 2 | — |
| CPU loop (5e8 iters) | 1446ms | 3079ms | 2.1x |
| find over 28,202 files | 0.124s | 81.3s | 655x |
| node startup | 0.093s | 0.161s | 1.7x |
| single file read | fast | 0.016s | ~normal |
| `npm run check` (whole repo) | 25s | 482s | 19x |

Check breakdown in-guest: biome 0.7s → 20.5s (tree walk + lstat), tsc cold
seconds → 128s (stats every source/type file), validate `extensions/**` ~2s →
63.5s, vitest 19.8s → 264s (discovery + import resolution), plus a 2-vCPU cap
serializing vitest workers.

## Diagnosis

Per-operation latency, not throughput or disk: each stat/lstat/readdir is a
guest→host RPC at ~2.9ms vs ~4us host-side — roughly 650x per metadata op.
`find` burned 81s wall on 3.9s of CPU: pure wait. Process startup and raw
reads are near-normal, confirming the transport is the tax.

The host-side VFS layer already caches `readdir` (rpc-service), which does
not help: the cost is the round trip, so the cache must live guest-side,
inside sandboxfs (the fuse daemon).

## Options

1. **Upstream metadata cache in sandboxfs (the real fix)** — stat/lstat/readdir
   cache with a short TTL or write-invalidate, guest-side. Consistency stakes
   are low for workers: they branch from HEAD, the parent touches the
   worktree only at collect time, so a second of stale metadata is harmless.
   sandboxfs is a prebuilt upstream helper (swappable only via
   `sandboxfsPath`/source builds), so this belongs in
   github.com/earendil-works/gondolin issues — the benchmark above is the
   supporting data.
2. Custom sandboxfs build with a cache (`sandboxfsPath`) — technically ours to
   do, but forking a helper binary for a cache is the wrong maintenance bill.
3. **Local policy (adopted now)** — accept the latency and keep stat-bound
   gates host-side:
   - The full `npm run check` gate runs on the host at integration, never
     in-guest (already the working design; these numbers justify it).
   - Worker briefs verify with targeted `npx vitest run <file>` in-guest;
     expect tsc/stat-heavy tools to be slow, not broken.
   - Parent sessions under `--gondolin` should expect the same tax on
     interactive shell work.

## Decision

NOT worth filing upstream: owner decision (2026-09-25) is that nobody opens
an issue on earendil-works/gondolin — this document is the internal record
only. The bench and the draft below stay ready; revisit if the metadata cost
ever justifies either (a) filing with the same table, or (b) carrying a
custom sandboxfs via `sandboxfsPath`. Policy 3 is the operative answer today.

## Verification checklist

- [ ] Upstream issue filed — **owner decision: do not file**; draft below is
      an internal record, not a queued action
- [x] Policy 3 reflected in worker brief practice (targeted in-guest vitest;
      full check is a host-side integration gate)
- [ ] Re-bench `find`/`npm run check` in-guest after any sandboxfs metadata
      cache ships (ours or upstream's)

## Upstream draft (INTERNAL — do not file without a new owner decision)

Title: sandboxfs: guest-side metadata cache for stat/lstat/readdir

Body sketch: every metadata op on a mounted worktree costs a guest→host RPC
(~2.9ms vs ~4us host-side). A `find` over 28,202 files takes 81.3s in-guest
vs 0.124s host (655x); a full project check takes 482s vs 25s (19x). CPU
loops and process startup stay near-normal, isolating the cost to per-op
latency. Ask: a short-TTL metadata cache inside the guest fuse daemon.
Staleness risk is low for the dominant use case (isolated agent worktrees:
branched from HEAD, parent touches the tree only at patch collection), and
the host-side rpc-service already carries a readdir cache whose invalidation
pattern could be mirrored guest-side. Evidence table: see section
"Evidence" above.

- [x] Policy 3 reflected in worker brief practice: targeted in-guest vitest,
      full check is a host-side integration gate — DOWNGRADED 2026-09-25:
      swift-otter proved full `npm run check` passes in-guest (EXIT 0,
      1460/1460), so the gate may run either side; briefs still prefer
      targeted runs for speed. Bare-shell chaining needs node_modules/.bin
      on PATH (npm run injects it) — see sandboxed-worktree-git-lookup-fails.md.

## Lever result: tsbuildinfo carry (implemented, c1d6e15, 2026-09-25)

Config now carries `tsconfig.tsbuildinfo` + `tsconfig.test.tsbuildinfo`
into each worktree. Portability verified in-guest: BuildInfo read 0.085s,
incremental check 0.001s, 340 types, cache mtimes untouched, zero host
paths embedded — safe to reuse across worktrees.

Measured value, with a correction to the original estimate: warm wall time
in the sandbox is **28-44s per config, not 1-3s** — tsc still stats/reads
~1700 sources through sandboxfs (33.9-50.9s parse at ~4s CPU), so the cache
skips the type-build, not the file walk. Net: **typecheck 185s -> ~60s**
for both configs, ~125s saved per worker check. The 1-3s band is local-disk
only; the remaining floor is the same stat tax recorded above (won't-fix
upstream per owner decision).

Framing rule: call it "~60s typecheck", not "warm".

## Lever result: CPU count (closed, owner decision 2026-09-25)

Keep the VM default as is (2 vCPUs). The 1.56x measured on 8-way parallel
jobs is real but not worth the host contention with up to four concurrent
workers on an 8-core machine. No code change. The remaining performance
posture: provision 39-44s, typecheck ~60s (carry), targeted tests 2-14s,
stat-tax floor won't-fix upstream. No open levers left in this document.
