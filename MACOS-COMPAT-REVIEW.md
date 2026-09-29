# macOS Compatibility Review

Date: 2026-02-19. Scope: all 27 extensions plus shared `lib/` helpers. Method: six read-only review workers covered every TypeScript file under `extensions/`; the main session spot-verified the highest-impact claims against the source (marked ✅ in the verification table).

The repo has **zero `process.platform` branches**. Nothing is gated per-OS, so every Linux assumption runs unguarded on darwin. Most code is pure Node and platform-neutral. Two extensions need real work on macOS: `voice` and `approval-mode`.

## Verdict

- **2 breaks**: voice microphone capture cannot work on macOS, and its failure is silent.
- **24 degradations**: one crash path, one misdirected-kill path, one safety-layer gap, and a tail of environment-dependent failures.
- **10 cosmetic issues**: wrong help text, non-native conventions, inert features.

## Breaks — fix before shipping to Mac users

### B1. Voice capture spawns ffmpeg with the PulseAudio format
`extensions/voice/src/audio.ts:76-92` — `ffmpeg -f pulse -i default ...`. Homebrew ffmpeg has no `pulse` input device and macOS has no PulseAudio server. ffmpeg exits at once with "Unknown input format: 'pulse'". Because `hasFfmpeg` wins the branch order, a Mac with ffmpeg installed gets zero audio. ✅ verified
Fix: add a darwin branch — `ffmpeg -f avfoundation -i ":0" -ac 1 -ar 16000 -f s16le -` — or a sox fallback (`sox -d -t s16le -r 16000 -c 1 -`).

### B2. Voice capture failure is silent
`extensions/voice/src/audio.ts:108-118` — stderr is piped to `ignore` and there is no `error`/`close` listener on the recorder child. B1 turns into an overlay stuck on "Listening..." with a flat level meter. ✅ verified
Fix: capture stderr and add an `error`/`close` handler that closes the overlay with the exit reason. Also fix `extensions/voice/src/settings.ts:138-141`, which reports "Ready" from binary presence alone, and `extensions/voice/src/overlay.ts:194-196`, which tells Mac users to install `alsa-utils` (impossible via Homebrew).

Voice playback has a companion gap, one tier lower: `extensions/voice/src/playback.ts:19-24` tries only `pw-play` and `ffplay`. macOS ships `afplay` on every system and it plays WAV directly, so TTS could work with zero installs. ✅ verified Fix: put `afplay` first in the darwin chain.

## Safety-layer degradations — land before trusting approval-mode on a Mac

### S1. Hard-deny roots are Linux-only
`extensions/approval-mode/src/policy.ts:50` — the recursive-delete deny regex covers `/home|/root|/etc|/usr|/var|/tmp|/opt|/dev|/sys|/proc`. On macOS, `rm -rf /Users`, `/Applications`, `/Library`, `/System`, `/Volumes`, or `/private` is not hard-denied; with Approval Mode off it runs unchecked. ✅ verified
Fix: add the darwin roots to the alternation. One line.

### S2. No deny rule for `osascript` privilege escalation
`extensions/approval-mode/src/policy.ts:9` — the privileged-command rule covers `sudo|su|doas|pkexec`. `osascript -e 'do shell script "..." with administrator privileges'` triggers the GUI root prompt and bypasses the list entirely. ✅ verified
Fix: add a hard-deny rule for `osascript` combined with `administrator privileges`.

Note: `worker-sandbox` itself is darwin-capable — it delegates to `@anthropic-ai/sandbox-runtime`, which runs Seatbelt profiles via `/usr/bin/sandbox-exec` and refuses the `allowAppleEvents` weakening knob (`extensions/worker-sandbox/src/policy.ts:84-86`).

## Crash and kill-path degradations

### C1. Config watcher error can kill the session
`extensions/status-bar/status-bar.ts:86-97` — the synchronous `watch()` call is guarded, but the watcher has no `error` listener. libuv delivers async watch errors (unmounted volume, EPERM) as `error` events; with no listener they throw uncaught and take down the session. macOS backends surface these more often than Linux inotify. ✅ verified
Fix: attach `watcher.on("error", ...)` that logs and clears the watcher. Copy the pattern at `extensions/messenger/src/watcher.ts:62-64`. One line.

### C2. `killPidTree` fallback chain can end in `kill(-1)`
`extensions/workers/src/runner.ts:456-476` — with `pid = -1` (reached via `child.pid ?? -1` at line 848), the group-kill falls through to `process.kill(-1, "SIGTERM")`: a broadcast to every process the user owns. The `error` handler currently clears the timer first, so the path is latent — one refactor away. ✅ verified
Fix: guard `pid <= 0` at the top of `killPidTree` and drop the `?? -1`. Two lines.

## Statistical degradations — pid identity on macOS

`lib/presence-shards.ts:38-45` defines liveness as bare `kill(pid, 0)`. ✅ verified macOS recycles pids from a ~100,000-value space (default `kern.maxprocperuid` environment; Linux default is 32768, Fedora-style tuned systems use 4194304). Fast worker spawn churn makes a dead pid look alive sooner on macOS:

- Orphan workers classify as live; cancel and remove are refused (`extensions/workers/workers.ts:483-489`), janitor adoption never runs (`extensions/workers/src/store.ts:360-366`).
- A recycled pid holds a stale file lock; waiters time out and `spawn_worker` returns `provisioned: busy` (`lib/file-lock.ts:213-219`).
- Dead jobs keep spool logs forever (`extensions/background-jobs/src/runner.ts:66-67`).
- Tail risk: cancel on a misclassified orphan group-kills the recycled pid — an unrelated victim.

Fix: stamp records and locks with the owner's process start time (`ps -p <pid> -o lstart=` works on BSD ps and procps alike); treat "alive" as pid plus start-time match. This is the largest fix in the review — a shared-lib change.

## Remaining degradations

| # | Location | Problem on macOS | Fix |
|---|----------|------------------|-----|
| D1 | `extensions/missions/src/actions.ts:90-99`, `extensions/autoresearch/src/measure.ts:86-105` | Verification and measure commands run via `/bin/sh` = bash 3.2 on macOS; bash-4 or GNU-flag commands flip done tasks to `regressed` | Append `process.platform` to failure output; document POSIX-sh requirement |
| D2 | `extensions/messenger/src/identity.ts:54-60`, `lib/presence-shards.ts:50-52` | Case-variant agent names collide on case-insensitive APFS: shared mailbox, clobbered presence | Case-fold the live-holder check; the volume probe at `store.ts:487-513` already exists |
| D3 | `extensions/background-jobs/src/runner.ts:118` | Job labels keep case in spool filenames; `Build`/`build` interleave one log on APFS | Lowercase filename components |
| D4 | `lib/file-lock.ts:157-171` | `link()` fails on exFAT/SMB volumes (common on Macs); lock creation throws | Fall back to `open(lockPath, "wx")` on non-EEXIST errors |
| D5 | `lib/git.ts:37`, `extensions/autoresearch/src/measure.ts:107-114`, `extensions/status-bar/status-bar.ts:413-431` | GUI-launched sessions get minimal PATH; Homebrew git missing → silent feature loss | Distinguish spawn ENOENT from repo absence; optionally prepend `/opt/homebrew/bin` |
| D6 | All `fetch` sites (`extensions/web-search/src/http.ts:21` +6 more) | undici/Bun fetch ignores `HTTPS_PROXY`; every network tool fails behind a proxy — common on managed Macs | Install undici `EnvHttpProxyAgent` as global dispatcher |
| D7 | `extensions/btw/src/constants.ts:13-15` | Option-as-Meta off by default in Terminal.app/iTerm2 → focus shortcut sends `÷`, overlay unreachable | Add a modifier-free binding (e.g. `ctrl+/`) |
| D8 | `extensions/session-recap/src/focus.ts:14,44` | DECSET 1004 is a no-op in Apple Terminal; focus recaps never fire there (degrades safely to idle fallback) | Skip enable when `TERM_PROGRAM=Apple_Terminal`; document |
| D9 | `extensions/worker-sandbox/src/broker.mjs:66-81` | On Homebrew Node (`/opt/homebrew/bin/node`) the sandbox-readable toolchain exception becomes all of `/opt/homebrew` | Grant the resolved Node root, not the package-manager prefix |
| D10 | `lib/json-atomic.ts:39-40` | `open(tmp, "w")` without `O_EXCL` + 2-byte suffix: concurrent writers can tear content (platform-independent; hits shared registries) | `randomBytes(8)`, `O_EXCL`, bounded retry |
| D11 | `lib/json-atomic.ts:40,48` | Rename publishes the temp file's mode; `0o600` state files widen to `0o644 & ~umask` | Stat the existing target and reuse its mode |

## Cosmetic issues

| # | Location | Problem |
|---|----------|---------|
| K1 | `lib/paths.ts:46-53` | Cache default `~/.cache` instead of `~/Library/Caches` on darwin |
| K2 | `extensions/status-bar/src/footer.ts:75-79` | Backslash fold runs on all platforms; mangles legal `foo\bar` directory names |
| K3 | `extensions/voice/src/playback.ts:23`, `src/settings.ts:146` | Help text names Linux-only PipeWire |
| K4 | `extensions/tool-style/src/surface.ts:88-93` | pywal colors.json is a Linux convention; feature inert on macOS (fails closed cleanly) |
| K5 | `extensions/goal/src/constants.ts:18` | Nerd Font glyph (U+F023C) renders as tofu in stock Terminal fonts |
| K6 | `extensions/worker-sandbox/src/broker.mjs:45` | PATH fallback omits Homebrew prefixes (practically unreachable) |
| K7 | `extensions/worker-sandbox/README.md:44` | `sandbox-exec` is Apple-deprecated; still works today — document as a watch item |
| K8 | `extensions/web-search/src/truncation.ts:8-12` | Spill files accumulate in TMPDIR (macOS prunes after ~3 days) |
| K9 | `extensions/context7/src/config.ts:27` | Cache in `~/.cache` (same root cause as K1) |
| K10 | `extensions/context7/src/client.ts:84,120` | `fetch` without deadline; stale-cache fallback only helps after error (use `lib/fetch-timeout.ts`) |

## Clean by design

- No `/proc`, `/sys`, `/dev`, `/etc/os-release` reads anywhere in extension code.
- No `flock`/`fcntl`; the lock protocol is `O_EXCL` + `link` + liveness-gated reclaim (`lib/file-lock.ts`).
- Liveness uses `kill(pid, 0)` with EPERM-read-as-live — portable, just weak identity (see above).
- Case-insensitive volumes are probed, not inferred from the OS (`extensions/messenger/src/store.ts:487-513`).
- Atomic writes are rename-based, valid on APFS; temp files are target-siblings, no EXDEV.
- Process groups: `detached: true` + negative-pid kills behave identically on darwin.
- `codex-image`, `context`, `synthetic`, `todos`, `handoff`, `small-model`, `worker-model`, `worker-blocker`, `clear`, `session-utils`, `ask-user`: pure Node, platform-neutral, no findings beyond K-items.
- `worker-sandbox` has an explicit platform allowlist and fails closed on unknown OSes (`broker.mjs:58-59`).

## Recommended fix order

1. **B1+B2** — voice darwin capture/playback branch (`avfoundation`/`afplay`/sox) + honest error and status reporting. ~30 lines, two files.
2. **S1+S2** — approval-mode darwin deny roots and `osascript` rule. Two regex lines.
3. **C1** — watcher `error` listener. One line.
4. **C2** — `killPidTree` pid guard. Two lines.
5. **D10+D11** — json-atomic `O_EXCL` + mode reuse. One small PR.
6. **D1** — platform hint in verification/measure failure output.
7. **D5+D6** — ENOENT-vs-absence in git errors; proxy dispatcher for fetch.
8. **D2+D3** — case normalization for filenames and identity checks.
9. **pid identity** — start-time stamping in `lib/presence-shards.ts` + `lib/file-lock.ts`. Largest change; schedule separately.

## Verification

| Claim | Source | Main-session check |
|-------|--------|--------------------|
| `ffmpeg -f pulse` capture branch | B1 | ✅ read `audio.ts:68-135` |
| Playback chain lacks `afplay` | B-companion | ✅ read `playback.ts:15-30` |
| Silent recorder death | B2 | ✅ read `audio.ts:108-118` |
| Deny roots Linux-only | S1 | ✅ read `policy.ts:46-52` |
| No `osascript` deny | S2 | ✅ read `policy.ts:8-16` |
| Watcher has no `error` listener | C1 | ✅ read `status-bar.ts:85-99` |
| `kill(-1)` broadcast path | C2 | ✅ read `runner.ts:450-476, 840-870` |
| Bare-pid liveness + cancel refusal | pid section | ✅ read `presence-shards.ts:36-46`, `workers.ts:478-495` |
| `open(tmp, "w")` without `O_EXCL` | D10 | ✅ read `json-atomic.ts:30-53` |
| Mission verification via `/bin/sh` | D1 | ✅ read `actions.ts:85-105`, `exec.ts` |
| Messenger volume case probe exists | D2 context | ✅ read `store.ts:485-520` |
| macOS pid space vs Linux | pid section | ⚠️ direction confirmed; "40x faster" holds vs 4M `pid_max` only, not the 32768 default |

All other findings are worker-verified against source only; line numbers were captured during their full-file reads. No files were modified during this review.
