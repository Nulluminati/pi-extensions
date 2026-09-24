# One corrupt mission file blocks the entire mission listing

- Category: bug (robustness)
- Severity: lower
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

`listMissionSummaries` (`extensions/missions/src/storage.ts`) iterates mission files and calls `loadMission` per valid-id file with no error handling:

```ts
const mission = await loadMission(cwd, stem);
if (!mission) continue;
```

`loadMission` throws on invalid JSON, a shape mismatch, or a stored-id mismatch. The code comments that "a listing must not crash on hand-created or foreign files" — but that protection only covers files without a valid mission id.

## Impact

A single hand-edited or disk-damaged file permanently rejects `mission (action=list)` and `/missions` until someone deletes the file by hand. The error message is at least descriptive, and lifecycle paths degrade correctly, which is why this is lower rather than important.

## Resolution direction

Table row 21's open decision: skip corrupt missions with a warning and list the unreadable filenames in the result, or fail to force repair. The skip-and-surface option matches the module's own stated intent for listings.
