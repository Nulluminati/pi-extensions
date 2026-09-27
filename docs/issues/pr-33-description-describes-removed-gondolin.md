# PR #33 description describes removed Gondolin behavior

- Category: review UX / documentation
- Severity: low
- Status: open

## Evidence

The [PR #33 description](https://github.com/Nulluminati/pi-extensions/pull/33) says workers run in Gondolin, that Gondolin is mandatory, and that a shared registry survives restarts. It also cites 127 changed files and 1,189 tests. The current PR branch removed Gondolin. Workers now use `worker-sandbox`, and their session transcripts own worker records. The description predates these changes.

## Impact

Reviewers can assess the wrong security boundary and persistence model. The old verification totals also make it hard to tell which revision the description covers.

## Resolution

Update the PR description to describe OS sandbox routing, the worktree setup hook, transcript-owned records, and the current check results. Keep the known limits accurate for the revision under review.
