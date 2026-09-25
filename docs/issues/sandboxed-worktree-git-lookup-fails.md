# Sandboxed worktree workers can start git but cannot find the repository

- Category: bug (integration / sandbox mounts)
- Severity: important (blocks in-guest repo-aware verification for isolated workers)
- Found during: V3 wiring field probe (session swift-otter-4), 2026-09-25
- Status: open

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
- [ ] `git log --oneline -3` shows main-checkout history in-guest
- [ ] `git status` test cases (messenger/missions) pass in-guest
- [ ] A `git commit` attempt in-guest fails read-only (history intact)
- [ ] Mounts absent for non-worker sessions; no extra mounts outside workers
