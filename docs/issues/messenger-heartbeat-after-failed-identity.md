# Messenger heartbeat can publish an empty identity

- Category: messenger lifecycle / UX
- Severity: low
- Status: open

## Evidence

`agentName` starts as an empty string in `extensions/messenger/messenger.ts`. A failed `session_start` identity claim leaves it empty. The `agent_settled` handler still calls `heartbeat(ctx.cwd, agentName, ...)`, and `shardPath` writes a shard named `.json` for that empty name.

## Impact

Peers can see a nameless session in the roster after startup fails. Later mail and reservation actions have no usable identity.

## Resolution

Skip heartbeat and delivery until a valid identity is claimed. Test a failed identity claim followed by `agent_settled`; assert no empty-name shard appears.
