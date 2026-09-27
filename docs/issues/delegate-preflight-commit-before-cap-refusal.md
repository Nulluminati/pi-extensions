# Delegate setup files can commit before a limit refusal

- Category: worker UX / side effects
- Severity: low
- Status: open

## Evidence

`startDelegatedWorker` in `extensions/agents/src/delegate.ts` calls `assertProvisionReady` before checking the worker limit or a duplicate name. The preflight can commit dirty setup files to the project. A later cap or name refusal still leaves that commit behind.

## Impact

A refused delegate changes the user's Git history without starting a worker. The refusal does not mention the commit.

## Resolution

Check the worker cap and name before setup commits. Recheck after any awaited preflight step if concurrent delegates can reserve slots. Test a full worker cap with dirty setup files and assert that refusal leaves Git history unchanged.
