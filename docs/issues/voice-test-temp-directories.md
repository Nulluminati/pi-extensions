# Voice tests leak temporary model directories into /tmp

## Symptom

Development machines accumulate thousands of leftover directories in `/tmp`:

- 788 `pi-voice-tts-*` directories
- 1,399 `pi-voice-models-*` directories

The same `afterEach` cycle that runs on every voice test run creates a fresh
set and never removes them. On this machine `/tmp` held over 22,000 entries.

## Root cause

`test/extensions/voice.test.ts` builds stub model trees with `mkdtempSync`:

- `createDownloadedTtsModel()` creates `pi-voice-tts-*`
- `createDownloadedVoiceModels()` creates `pi-voice-models-*`

Each helper writes a fresh stub tree (model files with `"stub"` content,
about 12 KiB per directory). The suite's `afterEach` resets mocks, stubbed
environment values, and timers, but never removes these directories.

Every run of the voice suite — focused, full repository, or CI — leaves one
directory pair behind per creating test.

## Impact

1. Unbounded `/tmp` growth on every development machine that runs the voice
   suite, on Fedora and macOS alike.
2. Directory-listing noise for the developer and for tools that scan `/tmp`.
3. No disk-space risk today: the stub content is small. The count, not the
   size, is the problem.

Production is unaffected. The extension writes spoken-audio files with
`pi-voice-tts-<pid>-<timestamp>.wav` names, which is a separate mechanism.

## Proposed fix

Track every directory the two helpers create and remove them in the suite's
`afterEach`, for example through a small shared list:

```ts
const tempModelDirs: string[] = [];

function createDownloadedTtsModel(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-tts-"));
  tempModelDirs.push(dir);
  // ... existing stub tree ...
}

afterEach(() => {
  for (const dir of tempModelDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // ... existing resets ...
});
```

The same treatment covers `createDownloadedVoiceModels()`. Existing leftovers
can be removed once with `rm -rf /tmp/pi-voice-tts-* /tmp/pi-voice-models-*`.

## References

- `test/extensions/voice.test.ts`, `createDownloadedTtsModel()` and
  `createDownloadedVoiceModels()`
- `extensions/voice/src/playback.ts` — production audio file naming
