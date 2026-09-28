# Background-jobs prune can delete another live session's active spool log

- Category: bug (data loss, narrow)
- Severity: low
- Found during: PR #33 third-round review, 2026-09-27
- Status: open

## Evidence

`extensions/background-jobs/background-jobs.ts` prunes the shared spool directory on every `session_start` (`pruneSpoolDir(agentStateDir("background-jobs"), { keep: liveSpoolPaths })`). The `keep` set covers only this instance's jobs: the per-instance registry lives in each session's transcript, so session B's actively running job is invisible to session A's prune.

Two deletion paths can hit a live job's log from another session:

- Age: `SPOOL_MAX_AGE_MS` is 7 days. A job waiting on `wake_on_pattern` with no output for 7+ days has an old-mtime log that age-pruning deletes mid-run.
- Count: `SPOOL_MAX_FILES` is 200. Eviction sorts newest-first and deletes beyond the cap, so a silent (old-mtime) active log is an eviction candidate while younger finished logs survive.

Both quick fixes suggested during review were rejected on inspection: "exempt logs modified within the last hour" does not protect a log that has legitimately had no output for days, and "skip pruning when other live sessions exist" has no reliable signal — presence shards are project-scoped and only exist when the messenger extension is loaded, while the spool is agent-dir scoped and cross-project.

## Impact

A long-running silent job in one session can lose its spool log because another session started. The job keeps running; only its captured output is lost. Narrow: requires a second concurrent session and a job silent past the retention window or a spool over 200 files.

## Resolution direction

Stamp the owning pid into the spool filename (for example `job-<id>-p<pid>-<label>.log`) and have `pruneSpoolDir` keep files whose pid is alive via the existing `isProcessAlive` helper in `lib/presence-shards.ts`. That makes `keep` unnecessary for liveness and closes both paths without cross-session coordination. Needs a migration story for existing `job-<id>-<label>.log` names (treat them as pid-less: age/count rules apply, as today).
