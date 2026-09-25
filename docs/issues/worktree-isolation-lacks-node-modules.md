# Worktree isolation does not provision the dev environment

- Category: bug (environment provisioning) / design
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21; expanded after the lower-sev mission, 2026-09-24/25
- Status: resolved (2026-09-25) — design reviewed, spike-verified, implemented; see commits e7f9d65..8b40501

## Evidence

`createWorktree()` branches from HEAD into `.pi/worktrees/<id>`. A fresh
worktree carries tracked files only. `node_modules`, `.env`, and every other
gitignored path are absent by design.

The cost is not theoretical. In the lower-sev mission (2026-09-24), all four
first-round workers died provisioning: each ran `npm ci` inside the Gondolin
guest, whose disk cannot hold a 1.3 GB extract, and timed out at 900 seconds
with zero code produced. The manual workaround — hardlink-copying the parent's
`node_modules` host-side — took ~2 seconds and zero added bytes, but was not
sufficient: the guest is musl, the host tree carried only the glibc rolldown
binding, so vitest still failed until `@rolldown/binding-linux-x64-musl` was
fetched by hand (`npm pack`; host npm refuses via `EBADPLATFORM`). `biome`
(glibc binary) and `git` never ran in the guest at all.

## Design (reviewed 2026-09-25)

The design separates mechanism from policy. Extension code carries zero
ecosystem knowledge.

**Mechanism (agents extension):**
- Schema validation for the per-repo config, `.pi/provision.json` (path built
  from `CONFIG_DIR_NAME`).
- Three primitives with defined order — carry → share → provision command:
  - carry: copy declared gitignored paths; default deny-globs for secret
    shapes (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`),
    overridable only from `.pi/provision.local.json` (git-excluded,
    machine-local; `carryUnsafe` in the committed config is a named
    validation error); symlinks resolved only inside the project root.
  - share: `hardlink-copy` (reflink → macOS clonefile → hardlink fallback,
    writable spots broken out), `install`, `none`. Pure-JS fast path only;
    trees with native dependencies must use `provision`.
  - provision: the config's command, executed in a **throwaway Gondolin VM**
    mounted only to the worktree (parent `node_modules` unreachable), with
    `createHttpHooks` allowlist from a new `network` schema field and cache
    homes redirected to a persistent host dir (`cacheDir("provision")`,
    second mount) so worktree discard costs no re-download. Boots only when
    the config has a `provision` command.
- Locking: `lib/file-lock` keyed by config path; waiters bounded by
  `timeoutSeconds + 15s`, then return `provisioned: busy` without spawning.
- Ordering (review point D1, reservation invariant preserved): refuse-checks
  → reserve → dirty gate → createWorktree → provision (locked) → spawn.
  Provisioning time is bounded only by its own `timeoutSeconds`.
- Preflight: config missing + `isolate: true` → refuse spawn, no slot burned,
  pointer returned. Plan-mode / non-isolated workers →
  `provisioned: skipped (no worktree)`. Provision failure → refuse spawn with
  exit detail; the failed record carries its `worktree` so remove/prune owns
  it. Staleness: sha256 fingerprints of `detect.any` inputs stored in
  `.pi/provision-state.json` (via `excludeFromGit`), not in the tracked
  config.
- Config persistence (review point D2): the mechanism commits config changes
  host-side, path-limited (`git commit --only`, fixed message), announced via
  `ctx.ui.notify`. Commit failure **refuses** the delegate with a named reason
  (warn-and-continue is impossible against the dirty gate).
- Status: `WorkerRecord.provision = { state: yes|none|failed|skipped|busy,
  detail, at }`, rendered by `formatWorkerStatus`, echoed in both delegate
  responses.
- Worker warning: the runner appends an ENVIRONMENT block to the task prompt
  at spawn (the pattern used manually in the mission's briefs). No messenger
  dependency; `report_blocker` (spool channel) carries evidence back.

**Policy (per repo, committed):** `.pi/provision.json` — `carry`, `detect`,
`provision`, `share`, `timeoutSeconds`, `network`, `providesOwn`. No built-in
adapters in extension code; the main conversation model authors config when
missing/stale, guided by a SKILL.md bundled with the extension and
materialized into `.pi/skills/provision/` (version-stamped; user deletion
resets to bundled default). Triggers: delegate result pointer lines and a
static hint in the blocker wake. No standing promptGuidelines line.

**Loops (no human in the gate):** seconds (blocker → amend → retry once →
loud failure), per project (generate / stale-refresh → mechanism commits),
per ecosystem (repeated manual repairs become skill edits, then upstream
PRs). Workers never author config; their blocker text is evidence only.

**Trust:** bundle A (sandboxed command execution) is the plan of record.
Bundle B (read-before-first-delegate, deny-list speed bump, PR scrutiny norms)
is a stopgap only; per review point D3 it would additionally require an
explicit human gate on first-seen committed configs.

## Spike outcome (2026-09-25) — Q3 verified, bundle A confirmed

One Gondolin VM, `createHttpHooks({ allowedHosts: ["registry.npmjs.org",
"*.npmjs.org", "*.npmjs.com"] })`, throwaway project mount + persistent cache
mount:

| Check | Result |
|---|---|
| Guest facts | Alpine, musl libc x86_64, node v24.14.1, npm 11.11.0 |
| `npm install` through allowlist | PASS — exit 0, 16s |
| Platform correctness | PASS — npm auto-selected `@rolldown/binding-linux-x64-musl` |
| Native module in guest | PASS — `require("rolldown")` loads (the exact round-1 failure) |
| Persistent cache mount | PASS — 25.8 MB in `/cache`, worktree clean |
| Egress deny | PASS — non-allowlisted hosts get a policy `403 Forbidden` at the network layer, covering direct sockets (node `fetch`), not just proxy-aware clients |

Refinement: deny manifests as an HTTP 403 response, not a connection error;
probes must assert on status, not on fetch rejection.

## V3 custom guest image — built and boot-tested (2026-09-25)

Config: `extensions/gondolin/guest-image.json` (alpine-base defaults + `git`).
Output: `~/.cache/pi-gondolin/guest/` (verify: `gondolin build --verify`, all
checksums pass). Boot test via `VM.create({ sandbox: { imagePath } })`:

    git version 2.52.0
    node v24.18.1 / npm 11.11.0 / musl libc (x86_64)

This removes the "never run git" caveat from worker briefs once wired into
both VM.create call sites (gondolin.ts startVm, provision executor) with a
graceful fallback to the default registry image when the local build is absent.

Build recipe — IMPORTANT: do not use the CLI's default workDir. `/tmp` on this
host is mounted `usrquota` with a 3066M per-user limit and ~2.6G baseline
usage; a build spikes +407MB (rootfs.ext4 + extracted tree), so the kernel
write hits EDQUOT every time, surfacing as `UNKNOWN: unknown error, write`.
Build through the SDK instead with workDir on /home:

    buildAssets(parseBuildConfig(config), { outputDir, workDir: cacheDir/build-work })

Retried builds must clean leftover workdirs first or the quota re-triggers.

## Remaining decisions (separate from this issue)

1. pnpm migration for this repo (optional; per-worktree installs become
   near-free natively). Not required by this design.
2. glibc (Debian OCI) image variant for biome/host-binary parity — bigger
   lift than alpine+git; not required by bundle A.

## Implementation checklist

- [x] Primitive order carry → share → provision; per-OS copy chain
- [x] Throwaway provision VM with worktree-only + cache mounts, `network`
      allowlist wiring into `VM.create({ httpHooks })`
- [x] Preflight refusal paths (missing / stale / failed / busy / skipped)
- [x] Fingerprint state file via `excludeFromGit`; lock with parameterized
      timeout
- [x] Host-side path-limited config commit with `ctx.ui.notify`; failure
      refuses (D2)
- [x] Task-prompt ENVIRONMENT block; `WorkerRecord.provision` rendering
- [x] Version-stamped skill materialization; `carryUnsafe` local-only
      validation; secret deny-globs; symlink-escape guard
- [x] Cache retention bound for `cacheDir("provision")`
- [x] Tests: failed-provision record carries `worktree` and prunes; stale
      fingerprint refuses; preflight refusal precedes reservation; secret-glob
      carry refused; symlink escape skipped

## Field feedback — first live run (2026-09-25, session swift-otter-4)

Four delegates; three provision failures; final run "share reflink, command exit 0 (78s)".

Confirmed working: refusal pointers actionable, skill path present, recovery flow's
"second failure is loud" rule stopped the loop, commit `75d1f8b` scoped to the config
file only, `Provision:` status line with mode + duration is valued, ENVIRONMENT block
evidenced working through worker behavior.

Gaps to fix:

1. **Pointer lines lack evidence.** `failed (exec aborted)` and `failed (exit 137): .`
   (empty detail after the colon). npm debug logs had to be found manually under
   `~/.cache/pi-provision/npm/_logs`. Biggest ask: raw failure reason + `logs: <path>`
   in the pointer line.
2. **Skill gaps.** `share` default wording reads like a phantom enum value; default
   `timeoutSeconds: 120` too small for a cold install (user ended at 3600); no
   musl-guest/glibc-host note (the reason a plain copy cannot satisfy native tooling);
   no log-location pointer; no worked example for the combination that actually worked:
   `share: hardlink-copy` + `provision: "npm install --no-audit --no-fund"` (small
   reify delta, adds musl binaries, low memory) with `github.com` in network —
   `npm ci` cache-hit extraction was SIGKILLed (exit 137, likely sandbox OOM) and its
   postinstall hung on a GitHub download.
3. **Commit cadence undocumented + notification unseen.** Config commits only fire on a
   successful provision, so three interim edits stayed uncommitted (only final state
   landed in 75d1f8b). The "Provision config committed" notify was never seen —
   investigate wiring; surface the commit in the durable delegate result either way.
4. **Empty-patch collect fails.** `workers collect` on a read-only worker errors at
   `git apply` ("No valid patches in input"); user had to re-run with `apply=false`.
   Default must tolerate an empty patch.
5. Minor: `isolate: false` currently dodges provisioning entirely (hits the musl wall
   instead) — provision is easier to dodge than to debug. Document or close later.

Follow-up nuance (swift-otter-4, same run): failed-attempt config edits were
overwritten before any commit, so git history shows only the config that finally
worked. Surface the commit fact in BOTH delegate outcomes — "config committed"
on success and "config NOT committed (edits remain local until a provision
succeeds)" on failure — so intermediate uncommitted states are visible in the
conversation, not just in hindsight.
