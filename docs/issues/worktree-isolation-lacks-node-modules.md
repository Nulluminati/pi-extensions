# Worktree isolation does not provision the dev environment

- Category: bug (environment provisioning) / design
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21; expanded after the lower-sev mission, 2026-09-24/25
- Status: open (design reviewed and spike-verified; implementation pending)

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

## Remaining decisions (separate from this issue)

1. pnpm migration for this repo (optional; per-worktree installs become
   near-free natively). Not required by this design.
2. Custom Gondolin image (V3): `gondolin build` with `rootfsPackages`
   (git, toolchains) or a Debian OCI rootfs for glibc parity. Improves
   in-guest verification (`biome`, `git`); not required by bundle A.

## Implementation checklist

- [ ] Primitive order carry → share → provision; per-OS copy chain
- [ ] Throwaway provision VM with worktree-only + cache mounts, `network`
      allowlist wiring into `VM.create({ httpHooks })`
- [ ] Preflight refusal paths (missing / stale / failed / busy / skipped)
- [ ] Fingerprint state file via `excludeFromGit`; lock with parameterized
      timeout
- [ ] Host-side path-limited config commit with `ctx.ui.notify`; failure
      refuses (D2)
- [ ] Task-prompt ENVIRONMENT block; `WorkerRecord.provision` rendering
- [ ] Version-stamped skill materialization; `carryUnsafe` local-only
      validation; secret deny-globs; symlink-escape guard
- [ ] Cache retention bound for `cacheDir("provision")`
- [ ] Tests: failed-provision record carries `worktree` and prunes; stale
      fingerprint refuses; preflight refusal precedes reservation; secret-glob
      carry refused; symlink escape skipped
