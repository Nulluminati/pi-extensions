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

## Verification checklist (all proven by two live probes, 2026-09-25)

- [x] `git status` clean in an isolated worker against its worktree — probe
      `git-accept-2`: "On branch agents/...; nothing to commit, working tree
      clean", with NO manual `git config` (safe.directory rides VM env,
      commit ae9ce96).
- [x] `git log --oneline` shows main-checkout history in-guest — probe
      returned `4399372` then `ae9ce96` from inside workers.
- [x] `git status` test cases (messenger/missions) pass in-guest — probe 2
      ran both files green in-guest: missions fully passing with
      `PI_WORKER` inherited; the template-less-init gap that failed them was
      fixed in ae9ce96 (`excludeFromGit` creates `.git/info` itself).
- [x] A `git commit` attempt in-guest fails read-only — probe 1:
      "unable to create temporary file: Read-only file system", HEAD
      unchanged at `4399372`.
- [x] Mounts absent for non-worker sessions — unit test: "non-worker does
      not mount git metadata even when a .git pointer file exists".

## Probe protocol note (recurring trap)

In-guest test runs from worker sessions inherit `PI_WORKER=1`, so the
messenger extension's real worker guards reject `send` and free-text
`status` tests (4 failures that look like regressions but are the features
working). Run in-guest suites as:

    env -u PI_WORKER -u PI_MESSENGER_NAME npx vitest run <files>

This bit the same suite in the provisioning mission (prov-executor era) and
here; treat the stripped-env form as the standard worker-brief command.
