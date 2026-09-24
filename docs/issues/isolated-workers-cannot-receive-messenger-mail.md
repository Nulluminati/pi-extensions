# Isolated workers cannot receive parent messenger mail

- Category: bug (integration) / design
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

The worker spawn environment passes only a cleaned git env plus two variables (`extensions/agents/src/runner.ts:296-302`):

```ts
env: { ...cleanGitEnv(), PI_WORKER: "1", PI_MESSENGER_NAME: options.name }
```

Nothing pins the messenger state root. Messenger derives its state directory from the worker's cwd (`lib/paths.ts`), and an isolated worker's cwd is the worktree. So the worker watches `<worktree>/.pi/messenger/` while the parent and all peers write `<main-checkout>/.pi/messenger/`.

## Impact

The documented receive-only channel is dead for the default (`isolate: true`) worker: mail addressed to the worker lands in the main checkout's mailbox that the worker never reads. Only non-isolated workers actually receive mail.

## Resolution direction

Table row 17's open decision: forward the parent's messenger state root explicitly in the worker env (sharing one registry/mailbox tree across worktrees), or remove worker messaging for isolated workers and document it. Sharing preserves the documented behavior and is the smaller change; verify presence pruning does not evict workers whose cwd differs.
