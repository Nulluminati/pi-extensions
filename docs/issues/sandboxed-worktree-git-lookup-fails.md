# Sandboxed worktree workers can start git but cannot find the repository

- Category: bug (integration / sandbox mounts)
- Severity: important (blocks in-guest repo-aware verification for isolated workers)
- Found during: V3 wiring field probe (session swift-otter-4), 2026-09-25
- Status: resolved (implemented in `extensions/gondolin`; unit-tested in-guest;
  host-side `npm run check` and commit pending)

## Implementation note

`extensions/gondolin/src/git-metadata.ts` resolves the two metadata directories
by plain-text parsing (no git binary): the worktree `.git` file's `gitdir:`
line, then the gitdir's `commondir` file, resolved against the gitdir and
validated with a directory stat. `appendWorktreeGitMounts` in
`extensions/gondolin/gondolin.ts` adds the mounts only when `PI_WORKER=1`:
the gitdir gets a writable `RealFSProvider`, the main `.git` gets
`new ReadonlyProvider(new RealFSProvider(...))`, both keyed at their absolute
host paths (guest path equals host path). Any resolution failure (missing
`.git`, normal checkout, unparseable pointer, missing main `.git`) or
constructor error keeps the base mount set — `startVm` never throws for this.

Unit tests in `test/extensions/gondolin.test.ts` ("sandboxed worktree git
mounts") mock `node:fs/promises` and the `@earendil-works/gondolin` module;
they prove mount-set construction, provider writability split, absolute-path
keying, commondir resolution, and every silent-skip path, plus mount absence
for non-worker sessions.

## Evidence

With the V3 custom image wired (commit `3800924`), `git version 2.52.0`
exists inside worker guests — the 95 spawn-git-ENOENT failures lose their
cause. But every repo-aware command fails:

    $ git status
    fatal: not a git repository: /home/natekift/Projects/pi-extensions/.git/worktrees/w-<id>
    $ git log
    fatal: not a git repository: /home/natekift/Projects/pi-extensions/.git/worktrees/w-<id>

## Cause

A git worktree's `.git` is a *file* holding an absolute `gitdir:` pointer to
the main checkout's `.git/worktrees/<id>` directory. The sandbox mounts the
worktree root (guest `/workspace`); the pointer's target lives outside it, so
metadata resolution dies immediately. Inside that gitdir, `commondir` then
points `../..` at the main `.git` (HEAD, config, refs, objects) — also
outside the mount.

Parent (non-worker) sessions are unaffected: their mount root *is* the
checkout, so `.git` sits inside `/workspace`.

## Blast radius

- Tests that spawn `git init` in temp dirs: now PASS (no external metadata).
- Tests that run git against the current checkout (messenger/missions
  "keeps state out of git status" cases): move from ENOENT to "not a git
  repository" — still red in-guest until the mount exists.
- Investigation tasks (`git log/diff/blame`) in isolated workers: impossible
  in-guest.

## Resolution (decided)

Mount the metadata, split by trust:

1. **Worktree gitdir, read-write, at its absolute host path** — parses from
   the `.git` pointer file. Carries the per-worktree index and logs, so
   status/add staging/branch bookkeeping works.
2. **Main `.git`, READ-ONLY, at its absolute host path** — resolved via the
   gitdir's `commondir` file. Enables `status`, `log`, `diff`, `blame`,
   `branch -v`. Object writes (`git add` writing blobs, `git commit`) are
   denied by the read-only mount — aligned with the patch-capture model:
   workers do not commit; their changes travel as patches. The sandboxed
   code cannot rewrite history, HEAD, or refs.

Rejected alternatives: rewriting the pointer to a sandbox-local path (still
requires mounting the same content, minus transparency); full writable main
`.git` (hands untrusted code the repository); mounting only the gitdir
(`commondir` still resolves outside).

Implementation surface: `extensions/gondolin/gondolin.ts` mount set — when
running as a worker (`PI_WORKER=1`), parse the `.git` file (plain text, no
git binary needed), mount the two directories at their absolute host paths,
read-only wrapper for the main `.git`. Parent sessions unchanged.

## Verification checklist

- [ ] `git status` clean in an isolated worker against its worktree
      (host/guest-verify; unit tests prove mount construction only — an
      in-guest worker booted with the fixed extension must confirm end to end)
- [ ] `git log --oneline -3` shows main-checkout history in-guest
      (host/guest-verify, same caveat)
- [ ] `git status` test cases (messenger/missions) pass in-guest
      (host-verify; see environment note below — these in-guest cases currently
      fail for a second, unrelated reason: the guest rootfs `git` ships no
      `/usr/share/git-core/templates`, so `git init` produces no
      `.git/info/exclude` and the messenger/missions/agents temp-repo tests
      fail on the exclude file regardless of mounts)
- [ ] A `git commit` attempt in-guest fails read-only (history intact)
      (host/guest-verify)
- [x] Mounts absent for non-worker sessions; no extra mounts outside workers
      (unit test: "non-worker does not mount git metadata even when a .git
      pointer file exists")

## Host-verify items for the integrator

- `test/extensions/gondolin.test.ts` — full suite green in-guest including the
  new "sandboxed worktree git mounts" block (7 tests).
- Expected to flip green host-side once the above lands (they were already
  green on the host; in-guest they need the git-templates gap fixed too):
  - `test/extensions/messenger.test.ts` — "session_start keeps messenger state
    out of git status" (+ the four messenger tests sharing its `git init`
    fixture)
  - `test/extensions/missions.test.ts` — "session_start keeps mission state out
    of git status"
  - `test/extensions/agents.test.ts` — "session_start keeps worker state out of
    git status and migrates the legacy registry"
- Note: these tests shell out to `git init` in temp dirs; in this guest they
  fail with ENOENT on `.git/info/exclude` because the rootfs git package has
  no default templates — a separate image-packages issue, not the mount bug.
