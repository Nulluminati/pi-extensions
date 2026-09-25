# Provisioner redesign — decision brief

- Status: **awaiting owner decisions** (two questions below)
- Author: amber-badger-28 + solar-heron-80 (paired sessions), 2026-09-25
- Inputs: 11-finding code review (read-only, independently verified), stock-image empirical probe, Pi official examples/docs, community extension research
- Constraint: no shared-tree edits until an option is chosen

## The two decisions (everything else follows)

1. **Toolchain scope** — "the full toolchain Gondolin ships without a custom image":
   - (a) *stock-shipped tools*: node, npm, npx, uv, python3, bash, curl — measured from the default registry image, zero custom bits.
   - (b) *arbitrary ecosystem toolchains* (git, cargo, go, javac, gcc, …) with no image maintained by us.
   Scope (a) is achievable inside the current VM architecture. Scope (b) is not —
   not without mounting host toolchains into the guest or installing per worker
   VM, and the provision VM and worker VM are separate boots, so anything
   installed during provision never reaches the worker.
2. **Security boundary** — which isolation class is mandatory: micro-VM (Gondolin),
   OS-level sandbox (sandbox-runtime), or whole-process container. Official
   doctrine (`docs/security.md` upstream) calls whole-process "usually the
   strongest practical option" and tool-only isolation "narrower".

## Options matrix

| Question | A: Stock Gondolin + neutral config | B: Host OS sandbox (`@anthropic-ai/sandbox-runtime`) | C: Whole-process container |
|---|---|---|---|
| Zero ecosystem knowledge | Achievable (purge 5 shims + dead fields; config = verbs) | Achievable (policy file shape; tool-routing design required) | Achievable |
| Stock toolchain (scope a) | Yes, measured | Yes (host has more) | Depends on image |
| Arbitrary toolchains (scope b) | No — needs image or host mounts | Yes — host binaries natively | Only if Dockerfile installs them (still an image) |
| No custom image | Yes (stock fallback boots) | Yes — no images at all | No — a Dockerfile is an image |
| Isolation strength | Micro-VM — strongest single-tool boundary | Namespaces/seatbelt — medium; **official example is fail-OPEN** (falls back to unsandboxed bash; wraps bash only — read/write/edit and extension tools untouched) | Strongest per official docs; catches extension tools too |
| Egress policy | createHttpHooks — spike-proven (403 at network layer, raw sockets included) | `allowedDomains` in sandbox config — unverified by us | Container network config |
| Perf | Current ledger: provision 39-44s, typecheck ~60s, stat floor parked, 2 vCPU | **Hypothesis only — must benchmark before believing** | Mac adds a VM layer |
| New dependency | None | `@anthropic-ai/sandbox-runtime` — requires owner approval (AGENTS.md) | Container runtime assumed present |
| Effort to reach | Purify mechanism + capability probes + explicit image config | Re-architect worker tool routing + fail-closed semantics + platform verification + network/secret policy port + benchmark | Container story for worktrees, mounts, patch flow |

## Findings-to-fix mapping (11 review findings)

**Universal — needed under every option (start immediately after choice):**
- #4 npm env/logs → generic `env` + `logPaths` config, captured-output diagnostics
- #5 `providesOwn` dead field → remove or implement (verified: validation-only)
- #6 skill factual errors + JS-heavy framing → rewrite around generic verbs; ecosystem examples become optional recipes (skill currently contradicts preflight-commit and claims host-side installs)
- #7 staleness misses input removal → route through `sameInputs` (exists at config.ts:166, only gates writes today) + removal test
- #8 carry traversal + nested symlink escape → normalize relative paths, verify every symlink target; tests for `../` and nested escape (P1)
- #9 `pruneProvisionCache` has no production caller → wire under lock or drop the retention claim
- #10 `network` omitted = allow-all → default deny or require explicit, documented
- #2 hardlink write-through mutates parent tree → clone/reflink-only for writable trees, or enforced read-only destination (P1; universal — worktrees exist under all options)

**Option A–specific:**
- #1 `share`: remove dead `install` enum, replace hardcoded `node_modules` with explicit project-relative copy entries (P1)
- #3 image: explicit config > env > SDK default (steal from autonomous-toaster/pi-gondolin), no auto-pick from cache; capability probe (`command -v`) before delegation, report honestly; "do not claim git works stock" (P1)
- Two-VM toolchain gap → capability checks in BOTH VMs; toolchain via shared image/artifact only

**Option B–specific:**
- Official sandbox example fails open and wraps bash only — our version must fail closed and explicitly decide which tools route through it (bash, read/write/edit, grep/find, `!`, extension tools)
- Port `network` → allowedDomains semantics (upstream docs: HTTP allowlists vs SSH/raw TCP are separate rules)
- Benchmark the perf claim before publishing it (current "all costs vanish" is an unmeasured hypothesis)
- Dependency approval gate

**Option C–specific:** container lifecycle for worktrees/patch capture; still an image; Mac VM overhead.

## External research (design input, not proof)

- Pi official `subagent/` example: process-per-agent, markdown roles, bounded concurrency, no worktree/provision/sandbox — our extension is intentionally beyond official scope.
- Pi official `gondolin/`: bare `VM.create` mount only — stock is the official baseline.
- Pi official `sandbox/`: policy-file pattern worth stealing (`network.allowedDomains`, `filesystem.denyRead/allowWrite`) — but fail-open and bash-only as shipped.
- nicobailon/pi-subagents: **finite** per-worktree setup hook + fail-closed preflight — steal the bounded contract, not the orchestration.
- autonomous-toaster/pi-gondolin: explicit image selection order (config > env > default).
- pasky/pi-gondolin: works stock for basic tools; stock never implies git.
- Upstream gondolin network docs: HTTP allowlist ≠ SSH/raw-TCP rules; keep `network` semantics explicit.

## North star (both sessions, signed)

Project setup = a bounded hook (policy). Capabilities = probed at runtime
(mechanism). Policy = explicit config. No strategy registry until a second
real strategy exists. The mechanism speaks verbs — carry, copy, run, probe,
stamp — and never names a package manager.

## Recommended sequence after the decisions

1. Apply universal fixes (they are option-independent; carry security P1 first).
2. Implement the chosen option's specific list.
3. Re-run the acceptance battery in-guest/host per option, including a fresh
   benchmark pass for B if chosen.
4. Update skill + README to the chosen architecture; close the shims inventory.
