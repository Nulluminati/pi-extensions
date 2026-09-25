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

## 8a. Migration landed (2026-09-25, third session)

The rewrite is complete. Landing evidence (host check plus live sandbox acceptance):

- **Full removal executed**: `extensions/gondolin/`, `lib/guest-image.ts`,
  the ambient stubs in `types/pi.d.ts`, the `@earendil-works/gondolin`
  dependencies (root and `extensions/package.json`), the validator allowlist
  swap to `@anthropic-ai/sandbox-runtime`, the gondolin suites
  (gondolin, gondolin-lazy, guest-image, provision-skill, provision-config,
  provision-executor, provision-primitives), status-bar's VM segment,
  `.pi/provision.json`, `.pi/provision-state.json`, and the old
  `provision/{config,executor,primitives,skill}.ts` set are all deleted.
  `rg gondolin` outside reference/docs now matches only the two negative
  assertions in agents.test.ts (`expect(args).not.toContain("--gondolin")`).
- **New architecture**: `extensions/worker-sandbox/` (policy + fail-closed
  broker + broker.mjs + tool-child.mjs). Workers load it pinned last via
  `REQUIRED_WORKER_EXTENSIONS`. `runner.ts` no longer knows a sandbox flag;
  it is extension-driven. `delegate.ts` v2 preflight = hook executability +
  policy JSON check + path-commit of `scripts/provision-worktree` and
  `.pi/sandbox.json`; `provisionWorktree` = carry (`.worktreeinclude`,
  `carry.ts`) then hook (`hook.ts`, inside the sandbox, bounded ten minutes,
  per-run log in the provision cache). Blocker wakes name the setup files.
- **Project conversion**: `.pi/provision.json` (share/hardlink/fingerprint)
  dissolved; replaced by `scripts/provision-worktree` (npm install),
  `.worktreeinclude` (two tsbuildinfo lines), and `.pi/sandbox.json`
  (npm/GitHub/NuGet allowlist, deny `~`/`/tmp`/`/run` reads,
  worktree-root writes, deny `.env`).
- **Gates closed**: host `npm run check` = biome + tsc + validate + 56 files
  / 1348 tests, zero errors, zero warnings. Live acceptance ran the real
  code paths against a disposable repo: worktree created, include path
  carried, hook exit 0 with a writable mark inside the sandbox and its log
  in the cache, and a full `pi --mode json --no-session` worker against the
  pinned extension set completing with the sandbox armed (7/7 PASS). The
  earlier srt spike covers the hard network facts (HTTPS 200/403 by
  allowlist, raw TCP ENETUNREACH, host Unix socket EPERM at `/tmp/claude`,
  external sockets in `/home` and `/run` hidden). Perf ledger update:
  full check in the strict sandbox ~19.8 s vs recorded in-guest 342–597 s;
  stat-tax baseline `find . -type f` 860 ms sandboxed vs 81.3 s in-guest.
- **Surviving behavior verified**: no-slot burned on refusal
  (fakeWorktreeGit), failed provision keeps worktree on the record, busy
  discards it, non-isolated skips, plan-mode read-only,
  `report_blocker` wake points at the setup files, composeWorkerTask
  ENVIRONMENT block unchanged, runner no longer names a sandbox runtime.

The repository's own isolated delegate also passed on 2026-09-25, after the
fixture run. Worker `w-muhgs7h0-dcdb7b153aad01df` carried four files and
completed the setup hook in 32 seconds. It created a marker only in its
worktree. Its sandboxed `git status` reported that file, and patch capture
recorded the exact addition. Direct TCP failed; the HTTP proxy rejected a
connection to `1.1.1.1` with 403. The test patch stayed unapplied, and the
parent checkout remained clean.

This run found three setup problems that the fixture did not cover. The
`socat` binary must be readable inside the sandbox. Linked worktrees need
read-only access to their parent's Git metadata. Finally, native package
scripts need Node's proxy option, while npm needs temporary storage outside
this host's nearly full `/tmp` quota. Commits `2bcbbea` and `b749625`
address the latter two problems; the hook also skips Husky installation
because the parent's Git configuration is read-only. The current full check
passes 58 files and 1353 tests.

**Owner-facing operational notes**

1. socat is NOT installed on this host (Fedora 43): `dnf install socat`,
   alongside the already-present `bwrap` and `rg`. The earlier srt spike
   extracted the RPM under /tmp for testing; that copy is not referenced by
   anything tracked here. For the live delegate, a temporary local copy was
   placed in the active Node installation's `bin` directory, which the
   sandbox already permits reading. Install the system package before
   removing that copy or changing Node versions.
2. macOS main uses `sandbox-exec` (deprecated since 2016; used by Codex
   and Codex-class tools today). Accepted risk per the brief.
3. `sandbox-runtime` version: added at 0.0.77. The dynamic
   `SandboxManager.getLinuxHttpSocketPath()` rebind keeps srt's
   `/tmp/claude` proxy reachable under the `/tmp` denyRead.

## 8b. North star (archive — Original text preserved below)


Project setup = a bounded hook (policy). Capabilities = probed at runtime
(mechanism). Policy = explicit conventional files. No strategy registry until
a second real strategy exists. The mechanism speaks verbs — carry, copy, run,
probe, stamp — and never names a package manager.

## 9. Fedora srt spike (2026-09-25, next session)

Gate 1 cleared: Zero Cool explicitly approved adding
`@anthropic-ai/sandbox-runtime`. The initial spike installed version 0.0.77
under `/tmp/pi-srt-spike`; after the proof, the package was added to
`package.json` and `package-lock.json`. No worker routing has changed yet.
Fedora 43 already has `bwrap` and
`rg`; it lacks `socat`. Without `socat`, `SandboxManager.initialize()` refuses
startup. A Fedora RPM was extracted under the same temporary directory and
put on `PATH` for the remaining tests. A production setup must check all three
prerequisites and explain missing packages.

Under a policy that permits writes only in a temporary work directory, denies
one read path and one protected write path, and allows only `example.com`:

- Sandboxed `cat`, redirection, `sed -i`, `rg`, `find`, and `ls` worked.
  Reads of the denied file failed with `Permission denied`. Writes to the
  protected file failed with `Read-only file system`; its host content stayed
  unchanged. This tests command equivalents, not Pi's seven tool adapters.
- HTTPS to `example.com` returned 200. HTTPS to `iana.org` returned proxy 403
  with `X-Proxy-Error: blocked-by-allowlist`. A direct Node TCP connection
  to `1.1.1.1:443` failed with `ENETUNREACH`; direct curl could not resolve a
  host. These tests establish network enforcement with the default Unix-socket
  restriction in place.
- Initialization took 115–120 ms. A wrapped `find . -type f >/dev/null` in
  this repository took 860 ms, versus 120 ms on the host and 81.3 s in the
  VM ledger. Each small wrapped command took 14–23 ms. These are single runs,
  not a distribution. No cold typecheck comparison was run.
- The default Unix-socket restriction stops this repository's `tsx` CLI:
  `npm run check` failed with `listen EPERM` on its local IPC pipe. Setting
  `network.allowAllUnixSockets: true` let the check finish in 20.1 s, with
  58 test files and 1461 tests passing, compared with the VM's 342–597 s.
  But that setting is **not safe by default**: a sandboxed Node process then
  connected to a host Unix socket outside the worktree and read its response.
  With the default restriction the same connection failed with `EPERM`.
  A follow-up policy denied reads of `/tmp`, then allowed only the temporary
  work directory and srt's installed helper. It blocked the same host socket
  with `ENOENT` even when Unix sockets were enabled. This is one path test,
  not proof that every host socket is hidden by a worker policy.
  With the broker outside the repository, a stricter policy denied reads of
  `/tmp`, `/run`, and the home directory. It reopened only the worktree,
  the runtime binaries, and a private temporary directory. The full check
  passed with clean output in 18.9 s (58 files, 1461 tests). The host socket
  stayed hidden, but HTTPS to an allowed domain failed with `Proxy CONNECT
  aborted`: the `/tmp` deny also hid srt's own proxy socket. A wrap-time
  read exception for exactly the proxy socket paths returned by srt fixed
  this. HTTPS to `example.com` returned 200, HTTPS to `iana.org` returned
  proxy 403, and direct TCP failed with `ENETUNREACH`. The host socket stayed
  hidden. `npm run check` passed with clean output in 22.1 s (58 files,
  1461 tests). However, this candidate **fails the host-socket gate**:
  srt always re-binds `/tmp/claude` for writes. A sandboxed process connected
  to a host Unix socket there and read its response, even with explicit
  `denyRead: ["/tmp", "/tmp/claude"]`. Equivalent sockets under the home
  cache and `/run/user/1000` remained hidden. The broad Unix-socket option
  cannot be the default worker policy on this host.
- srt injects absent sensitive dotfiles as device nodes beneath its broker's
  current directory. When the broker ran from the repository, Biome reported
  `.mcp.json internalError/io Permission denied` while returning exit 0.
  Running the broker from a temporary directory, while spawning the wrapped
  command in the repository, made `npm run check` output clean. The worker
  implementation must keep these mount artifacts outside the worktree.
- `SandboxManager.wrapWithSandbox()` **does not refuse an uninitialized
  manager**: it returned a wrapper without `--unshare-net` before
  `initialize()`. `reset()` also left `isSandboxingEnabled()` true. Do not
  treat either API as a fail-closed readiness check. Keep an explicit local
  ready state that becomes true only after successful initialization and
  becomes false before reset; refuse every tool call otherwise.

Zero Cool chose to continue the strict-policy spike, not to accept broad
host Unix-socket access. With the default Unix-socket restriction restored,
`/tmp/claude` host socket access failed with `EPERM`; allowed HTTPS still
returned 200. `node --import tsx scripts/validate-all.ts` passed in 1.2 s,
and `npm run test` passed cleanly in 18.2 s (58 files, 1461 tests). The
`tsx` CLI still needs IPC. The repository's `validate` and `validate:one`
scripts now use the socket-free loader. Under the same strict policy,
`npm run validate:one extensions/agents/agents.ts` passed, and the complete
`npm run check` passed with clean output in 19.8 s (58 files, 1461 tests).
Allowed HTTPS returned 200, denied HTTPS returned proxy 403, direct TCP
failed with `ENETUNREACH`, and the `/tmp/claude` host socket failed with
`EPERM`. A separate temporary probe ran Pi's actual `createReadTool`,
`createWriteTool`, `createEditTool`, `createLsTool`, `createFindTool`,
`createGrepTool`, and `createBashTool` inside a sandboxed Node child. All
seven worked. A denied read returned `ENOENT`, and a denied write returned
`EROFS`. The broker refused calls before initialization and after reset.
With `socat` absent, initialization failed and the readiness guard refused
another call without spawning the command. The bash factory needs `exposeSessionEnvironment: false` without a live Pi
session manager; the broker must pass approved session metadata explicitly.
This child-process approach keeps Pi's direct path probes and grep subprocess
inside the sandbox, unlike host-side operation adapters. It is a spike, not
production routing: cancellation, streamed output, large binary results,
and `user_bash` (`!`) still need tests. Gate 2 remains **open** until those
paths are tested. Do not migrate workers
before the gate closes. The spike scripts and captured output are temporary
under `/tmp/pi-srt-spike`.
