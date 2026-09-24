# Pi 0.87.0 Impact Assessment

Researched 2026-09-21 against the [0.87.0 changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md). The installed pi at research time was 0.87.0, so all behaviors described here are live.

Summary: no breaking changes hit this repo directly. One silent behavior change affects both provider extensions (strict tool schemas). Two new APIs map onto existing extension patterns and are candidates for deliberate migration.

## Breaking changes — all clear

| Change | Why we are unaffected |
|--------|----------------------|
| `shouldStopAfterTurn` removed; use `finishTurn` returning `{ action: "end" }` | No repo extension uses it. |
| `ContextEditEntry` added to the `SessionEntry` union | Branch-walking extensions (goal, missions, messenger, web-search, btw) filter on `entry.type === "custom"` or `=== "message"`, so `context_edit` entries pass through harmlessly. No exhaustive switches exist. |
| SessionManager canonical for provider context; `session.agent.state.messages` no longer assignable | No extension touches that field. |
| Expanded `TurnEndEvent` (required boundary fields) and `AgentBeforeSettleEvent` added to `ExtensionEvent` | Only breaks event *constructors* and exhaustive switches. Our `turn_end` consumers (goal, status-bar, session-recap) only read event data or schedule work. |

## Real behavioral change: strict tool schemas (#9816)

Unknown OpenAI-compatible endpoints no longer receive strict tool schemas. `supportsStrictMode` now defaults to `false` in `detectCompat()` ("OpenAI compatibility alone does not imply strict JSON-schema tool support").

Both provider extensions register `api: "openai-completions"` against base URLs pi does not recognize:

- `synthetic` → `https://api.synthetic.new/openai/v1`
- `neuralwatt` → `https://api.neuralwatt.com/v1`

Requests still work, but tool schemas are no longer strict-enforced. If a provider supports strict tools, restore it per model in `extensions/<name>/src/models.ts`:

```typescript
compat: { supportsStrictMode: true },
```

Verify against each provider's actual API before flipping. This is the only concrete follow-up from the changelog.

## Fixed behaviors that help for free

- **Context handlers no longer see system messages; pi replays the prompt and tool declarations after filtering** ([#9789](https://github.com/earendil-works/pi/issues/9789), [#9822](https://github.com/earendil-works/pi/issues/9822)). `goal`, `plan`, and `btw` filter by `customType` only. They were safe before and are structurally safer now; the compaction-after-filter failure mode cannot touch them.
- **`agent_settled` dispatch is non-reentrant.** Work requested from settled handlers runs after all settled handlers finish. `messenger`'s heartbeat + inbox delivery runs there; its `deliverInbox` → follow-up chain can no longer interleave with another extension's settled handler. No code change needed.

## New capabilities mapped onto existing patterns

### `agent_before_settle` boundary

The designed replacement for the continuation loop in `goal` and `autoresearch`. Both currently use `agent_end` + manual guard flags (`continuationQueued`, `evaluating`, `hasPendingMessages()`) + `pi.sendUserMessage(..., { deliverAs: "followUp" })`.

The new boundary runs after retry/final-attempt recovery completes, appends `custom_message` entries in transcript order, and guarantees exactly one next provider request per `continue: true` — eliminating the guard dance. Docs caveat: an unconditional `continue: true` is re-evaluated after each response and can loop forever; goal's existing guards already anticipate this pattern.

Migration is a behavior change worth doing deliberately, not urgently.

### `appendContextEdit` / `context_edit` entries

Persistent omission or replacement of a message without rewriting raw history. btw's per-turn `context` filter of side-thread messages remains the better tool there because threads get re-injected on `/btw:inject`. Marginal use elsewhere; note as available.

### `context_with_system`

Per-request transformation of the full transcript including system messages. No current extension needs it; escape hatch only.

## Type stubs

`types/pi.d.ts` lags the 0.87.0 event map: no `agent_before_settle`, `context_with_system`, `context_edit`, or `turn_end` boundary fields (`messageEntryId`, `outcome`, `entries`, `continue`, `context`). Must be updated before adopting any of the new APIs, per repo rules.
