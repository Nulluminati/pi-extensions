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
