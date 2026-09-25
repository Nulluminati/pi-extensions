# Provisioner rewrite — handoff

- For: **a new session with zero context** (owner directive, 2026-09-25)
- From: amber-badger-28 (this session) + solar-heron-80 (review session, read-only, no tree state)
- Status: direction decided; implementation not started; two gates open (below)
- Companion docs: `docs/provisioner-redesign-options.md` (decision brief),
  `docs/issues/worktree-isolation-lacks-node-modules.md` (provisioning design
  record), `docs/issues/sandboxfs-metadata-latency.md` (perf ledger), plus the
  issue files for mounts/env/egress evidence.

## 1. Owner mandate (the binding part)

Zero Cool, across today's conversation:

1. **No ecosystem knowledge in the provisioner mechanism.** No package-manager
   names, no `node_modules`, no npm paths in code. Policy belongs to the
   project; mechanism speaks verbs only.
2. **Image parity clarified:** our Gondolin image must be a superset of the
   default image. **PROVEN**: stock 294 binaries, ours 299; missing-from-ours
   = empty; extra = exactly the five git binaries. This requirement is met
   and is NOT the driver of the rewrite.
3. **No patching, no "universal fixes".** Today's churn (dead fields,
   contradictory skill, shims) is read by the owner as a deep architectural
   issue. Directive: **complete migration/rewrite.**
4. Direction chosen in conversation: **B — OS-level sandbox (srt)** replacing
   the micro-VM for worker execution. He asked "B sounds like a better
   option?", received the scorecard, did not object, and issued the rewrite
   directive immediately after. Treat B as decided, subject to Gate 1.

## 2. Gates (both must clear before/while building)

**Gate 1 — dependency approval (repo rule, NOT yet granted):**
`@anthropic-ai/sandbox-runtime` (srt) must be added as a dependency; AGENTS.md
requires explicit owner approval for new npm dependencies. Ask once, clearly:
Apache-2.0, node+shell, no new runtime. Until approved: research/spike
planning only, no `npm install`.

**Gate 2 — spike before building on it (the rewrite's first phase):**
prove on this Fedora host that srt is (a) fail-closed wrappable for bash +
read/write/edit/grep/find/ls with zero silent fallbacks, (b) actually faster —
beat these BASELINE numbers from the current VM world: provision 39-44s,
typecheck 185s cold / ~60s with carry, `find` 81.3s vs 0.124s host, full
check in-guest 342-597s vs ~25s host, VM boot <1s, 2-vCPU cap; (c) enforcing
domain allowlists (today's proof: provision VM returned policy 403s at the
network layer including raw sockets — srt must match that bar via its proxy).

## 3. What exists today (working, shipped, tested — read before deleting)

Full `npm run check` green: **58 files / 1461 tests**; it also passes INSIDE
a provisioned sandboxed worker (EXIT 0, 1460 — arc: 101 → 5 → 0).

- `extensions/agents/` — delegate/workers tools, worktree lifecycle, patch
  capture, reservation ordering (reserve before worktree), `report_blocker`
  channel (`worker-blocker` ext + `lib/worker-blocker.ts`), ENVIRONMENT task
  block, `WorkerRecord.provision` status rendering, widget with
  publish-on-completion fix.
- `extensions/agents/src/provision/` — types.ts (schema), config.ts (load/
  merge/validate/fingerprint staleness/exclusions), primitives.ts (carry with
  secret-globs + realpath guard, copyTreeShared reflink chain, cache prune),
  executor.ts (throwaway VM + allowlist + cache mounts), skill.ts +
  `assets/provision-skill/SKILL.md` (v2, version-stamped materialization).
- `extensions/agents/src/delegate.ts` — preflight ladder (validate → applies →
  path-commit BEFORE dirty gate → stale refuse), provision under file-lock
  (timeout + 15s = busy), refusal messages with logs pointer, failed record
  keeps worktree.
- `extensions/gondolin/` — tool routing into micro-VM, V3 image config
  (`guest-image.json`: stock set + git), image resolver with stock fallback,
  worker git-metadata mounts (gitdir rw / main .git ro) + GIT_CONFIG
  safe.directory env.
- `.pi/provision.json` — current committed recipe (detect/share/carry/provision/
  network/timeout). `test/setup/worker-env.ts` strips PI_WORKER* from all tests.
- Skill v2 has known FACTUAL ERRORS (claims host-side installs; claims
  commit-on-success) — do not trust it as a description of current behavior.

## 4. Why it's being replaced (the review — 11 findings, all verified)

Read the full matrix in the redesign brief. Headlines:

- **Lying contract:** `share: "install"` accepted but never implemented;
  `providesOwn` validated but never read; `pruneProvisionCache` has zero
  callers; skill states two things that are false.
- **Ecosystem leaks (mandate 1):** `delegate.ts` copies a directory named
  `node_modules`; `primitives.ts` hardcodes JS writable names
  (`.package-lock.json`, `.vite`, `.cache`, `.npm`); `provisionLogsDir`
  prefers `npm/_logs`; executor sets `npm_config_cache`.
- **Security:** carry accepts `../` and follows nested symlinks after only a
  top-level realpath check (escape/secret-import); hardlink fallback lets a
  worker's tool rewrite files inside the PARENT's tree; `network` omitted
  = allow-all.
- **VM-era structural:** two separate VM boots (provision toolchain never
  reaches the worker); image auto-picked from cache magic; no guest
  capability probe before delegation.

## 5. Empirical facts (don't re-derive)

- **Stock Gondolin image ships:** node, npm, npx, uv, python3, bash, curl
  (294 binaries). Absent: git, cargo, go, javac, gcc/make, pip, openssl,
  openssh. Probed by booting the default registry image.
- **Our image = stock + git** (parity proven, inventory diff).
- **srt** = `@anthropic-ai/sandbox-runtime` (anthropic-experimental,
  Apache-2.0, ~5k stars): native primitives — sandbox-exec (macOS) /
  bubblewrap (Linux) — plus proxy-based HTTP/SOCKS network filtering for
  domain allowlists. Pi's official sandbox example uses it
  (`examples/extensions/sandbox/` in pi-coding-agent): policy file with
  `network.allowedDomains` + `filesystem.denyRead/allowWrite/denyWrite`.
  **Known defects to NOT inherit:** the official example wraps bash only and
  falls back to UNSANDBOXED on init failure (fail-open). Our version must be
  fail-closed: sandbox init failure = refused spawn, never bare metal.
- **macOS risk:** sandbox-exec deprecated since 2016, works on 15.x, no
  replacement announced (Apple issue open May 2026). Accepted risk to state
  in the plan; used today by Codex CLI and Pi's example.
- **Pi official doctrine** (`docs/containerization.md`, `docs/security.md`
  upstream): four isolation methods; whole-process = "usually the strongest";
  tool-only = "narrower" (B stays tool-only, same category as today's A).
- **Perf ledger (VM world, the numbers to beat):** see Gate 2. Stat tax
  root cause: sandboxfs guest→host ~2.9ms/op (upstream cache = owner
  decision: DO NOT FILE; draft stays internal in the latency issue).
- **Operational rules that remain true:** in-guest tests need PI_WORKER
  stripped (setup file now does it); bare guest shells lack npm's
  node_modules/.bin PATH (use `npm run check` or prepend PATH); max 4 worker
  slots; NEVER `--no-verify`; shared tree = claim files via messenger before
  editing.

## 6. Target architecture (decided in conversation)

**`provision.json` is dissolved.** Three conventional, industry-aligned files
replace it — zero new schema, so dead fields are impossible by construction:

1. **Setup = a bounded executable hook** at a conventional path
   (e.g. `scripts/provision-worktree`). Any language via shebang — the
   project chooses. Runs once per worktree before spawn, bounded, exit code
   decides. (This is the "finite setup hook" pattern from nicobailon/
   pi-subagents — steal the contract, not their orchestration.)
2. **Carry = `.worktreeinclude`** (Claude Code's gitignore-syntax
   convention) — the only carry mechanism.
3. **Sandbox policy = `.pi/sandbox.json`** (Pi official example's
   convention): filesystem rules + `network.allowedDomains`. Owner's
   `network` field folds in here; validated by srt's schema, not ours.

**Mechanism keeps (all ecosystem-free):** preflight (dirty gate + path-commit
of setup files — a modified tracked setup file still breaks the worktree gate,
so generalized commit survives; fail-closed refusal ladder with skill
pointers), bounded hook executor with logs/out-tail diagnostics, worktree
isolation + patch capture + reservation ordering, `report_blocker` + wakes +
ENVIRONMENT block, skill rewritten to "write these three files".

**Mechanism deletes:** provision/executor.ts (throwaway VM), guest-image
resolver + `guest-image.json`, git-metadata mounts + safe.directory env,
share/install/providesOwn vocabulary, fingerprint staleness subsystem
(a setup script reads the lockfile itself — inherently current), cache
redirect env, our config schema + its validation surface.

**Self-repair loop survives unchanged:** worker `report_blocker` → wake →
main model edits the setup script / sandbox policy → normal commit →
re-delegate. Skill guides authoring; git history is the audit.

## 7. Phases

1. **Gate 2 spike** (srt fail-closed + benchmark vs baselines + egress proof).
2. **Sandbox module** — policy loader + fail-closed wrappers for every worker
   tool (bash, read, write, edit, grep, find, ls, `!`); failed init = refuse.
3. **Provisioner v2** — hook executor + `.worktreeinclude` carry + preflight
   generalization; host execution under the sandbox.
4. **Runner migration** — worker tools route via srt; Gondolin leaves the
   WORKER path (default stance: `--gondolin` main-session mode untouched
   until later — flag if the owner wants it retired too).
5. **Rewrite skill + README + migrate** the existing `.pi/provision.json`
   into the three-file form (one-time conversion; the model can do it guided
   by the new skill).
6. **Deletions + acceptance:** full check green on host AND sandboxed;
   benchmark recorded against Gate 2 baselines; egress deny demonstrated;
   all 11 review findings closed as moot-or-fixed-by-design; issue docs
   updated.

## 8. North star (both prior sessions, signed)

Project setup = a bounded hook (policy). Capabilities = probed at runtime
(mechanism). Policy = explicit conventional files. No strategy registry until
a second real strategy exists. The mechanism speaks verbs — carry, copy, run,
probe, stamp — and never names a package manager.
