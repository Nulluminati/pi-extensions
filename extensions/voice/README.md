# Voice Extension

Adds local speech-to-text dictation and text-to-speech playback to Pi with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and ONNX Runtime.

Hold Space for one second to dictate without leaving the editor. The extension can also summarize the latest assistant response with the global small model and read it aloud using Kitten Nano, Inflect Nano v2, or Inflect Micro v2. Recording, transcription, and speech synthesis run locally. Only summary generation uses a cloud model.

## Installation

Install the extension collection so Pi also installs the native sherpa-onnx and ONNX Runtime dependencies:

```bash
pi install git:github.com/Nulluminati/pi-extensions
```

## Requirements

The extension currently targets Linux audio systems.

- `sherpa-onnx-node` for transcription and Kitten speech synthesis. It is installed with this extension collection.
- `onnxruntime-node` for Inflect speech synthesis. It is installed with this extension collection and loaded only when an Inflect model is first used.
- `espeak-ng` for the Inflect English phoneme frontend.
- `ffmpeg` or `arecord` for microphone capture.
- `pw-play` or `ffplay` for speech playback.
- `pactl` is optional and useful for finding PipeWire/PulseAudio source names.

On Fedora, this installs a local recording and playback path without requiring ffmpeg:

```bash
sudo dnf install alsa-utils espeak-ng pipewire-utils pulseaudio-utils
```

The extension prefers `ffmpeg` for recording when both recorders are installed. It prefers `pw-play` for playback.

## Model setup

Models are stored in `$PI_VOICE_MODELS`, or `~/.cache/pi-voice/models` when the variable is unset. Open `/voice` to check whether each selected model is ready or missing.

For the default setup, download Moonshine Base, Kitten Nano, and Silero VAD:

```bash
models_dir="${PI_VOICE_MODELS:-$HOME/.cache/pi-voice/models}"
mkdir -p "$models_dir"
cd "$models_dir"

wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2
tar xf sherpa-onnx-moonshine-base-en-int8.tar.bz2
rm sherpa-onnx-moonshine-base-en-int8.tar.bz2

wget https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2
tar xf kitten-nano-en-v0_1-fp16.tar.bz2
rm kitten-nano-en-v0_1-fp16.tar.bz2

wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
```

Silero VAD is recommended but optional. Without it, the extension sends the full recording to the transcription model.

To add the two Inflect models:

```bash
mkdir -p "$models_dir/inflect-nano-v2-onnx"
wget -O "$models_dir/inflect-nano-v2-onnx/duration.onnx" \
  https://huggingface.co/owensong/Inflect-Nano-v2-ONNX/resolve/main/onnx/duration.onnx
wget -O "$models_dir/inflect-nano-v2-onnx/decode.onnx" \
  https://huggingface.co/owensong/Inflect-Nano-v2-ONNX/resolve/main/onnx/decode.onnx

mkdir -p "$models_dir/inflect-micro-v2-onnx"
wget -O "$models_dir/inflect-micro-v2-onnx/duration.onnx" \
  https://huggingface.co/owensong/Inflect-Micro-v2-ONNX/resolve/main/onnx/duration.onnx
wget -O "$models_dir/inflect-micro-v2-onnx/decode.onnx" \
  https://huggingface.co/owensong/Inflect-Micro-v2-ONNX/resolve/main/onnx/decode.onnx
```

## Commands

| Command | Action |
|---------|--------|
| Hold Space for one second | Open the dictation overlay |
| `/voice` | Open voice settings |
| `/voice-speak` | Summarize and speak the latest assistant response |
| `/voice-speak full` | Speak the cleaned response without cloud summarization |
| `/voice-stop` | Stop current speech generation or playback |

The dictation model, speech model, and selected Kitten voice persist across restarts. Spoken summaries use the global small model configured by `/small-model`.

## Voice settings

Run `/voice` to open the central settings modal. Use Up and Down to move, Enter or Space to change a setting, and Escape to close it.

The modal shows the complete local audio route:

- Dictation model, with `Ready` or `Missing` beside each choice.
- Speech model, with the same download status.
- Local voice. Kitten exposes eight choices; Inflect shows `Fixed voice` and disables this row.
- Recording input, playback output, and Silero VAD status.

A missing model stays visible but cannot be selected. Download it with the commands in [Model setup](#model-setup), then reopen `/voice`.

## Dictation

Hold Space for one second to dictate. A short Space press still inserts a normal space in the editor. `/voice` is reserved for settings.

The overlay shows the input level, elapsed recording time, and a partial transcript. Use:

- Enter to stop recording, finalize the transcript, and paste it into the editor.
- Escape, Ctrl+C, or Ctrl+X to cancel.

The default transcription model is Moonshine Base int8. Silero VAD removes silence before final transcription. The extension also drops common filler hallucinations and trims repeated-word loops.

Hold-to-dictate requires Pi's interactive TUI. It supports terminals with key-release reporting and terminals that expose a usable Space auto-repeat sequence.

## Spoken responses

`/voice-speak` reads the latest assistant message from the active session branch. It asks the global small model for roughly 40 to 70 words of plain spoken prose, removes Markdown formatting, then generates audio with the selected local speech model.

Choose the model with `/small-model`. Voice playback stops with an error if the configured model is missing or unauthenticated; it does not use the active chat model as a fallback.

Use `/voice-speak full` when the response is already short or when no cloud model should receive it. This mode strips Markdown, links, and fenced code before local synthesis. A response made entirely of fenced code has no speakable text.

Model engines are loaded on first use and cached. This keeps them out of Pi's startup path. Audio is written to a temporary WAV file, played with `pw-play` or `ffplay`, and removed after playback.

## Speech synthesis models

| Model | Backend | Weight size | Voice | Local benchmark |
|-------|---------|------------:|-------|----------------:|
| `kitten-nano-en-v0_1-fp16` | sherpa-onnx | About 42 MB extracted | Eight selectable English voices | RTF 0.355 |
| `inflect-nano-v2-onnx` | ONNX Runtime | 16.21 MB | One fixed English male voice | RTF 0.141 |
| `inflect-micro-v2-onnx` | ONNX Runtime | 37.75 MB | One fixed English male voice | RTF 0.232 |

RTF is synthesis time divided by generated audio duration, so lower is faster. The Inflect measurements used the extension's inference path on the development machine. Nano generated 2.06 seconds of audio in 0.29 seconds; Micro generated 2.16 seconds in 0.50 seconds. Kitten was measured with a longer sample.

Inflect's official ONNX export uses a duration graph and a decode graph. The extension runs both through ONNX Runtime, uses eSpeak-ng for English phonemes, and joins long text at punctuation-aware boundaries. Inflect models have fixed voices, so the voice row in `/voice` becomes read-only while either one is active.

Use `/voice` to switch models. The default remains Kitten Nano.

## Local voices

Kitten Nano provides eight speaker choices:

| Speaker | Voice |
|---------|-------|
| `expr-voice-2-m` | Voice 2, masculine |
| `expr-voice-2-f` | Voice 2, feminine |
| `expr-voice-3-m` | Voice 3, masculine |
| `expr-voice-3-f` | Voice 3, feminine |
| `expr-voice-4-m` | Voice 4, masculine |
| `expr-voice-4-f` | Voice 4, feminine |
| `expr-voice-5-m` | Voice 5, masculine |
| `expr-voice-5-f` | Voice 5, feminine |

The default is `expr-voice-2-m`. Use the local voice row in `/voice` to choose another speaker. These choices apply only to Kitten Nano because both Inflect models have fixed voices.

## Transcription models

| Model | Notes |
|-------|-------|
| `moonshine-base-int8` | Default. Fast English transcription and good tolerance for noisy microphones. |
| `whisper-tiny-en-int8` | Small general-purpose English model. |
| `whisper-small-en-int8` | More accurate than Tiny, with higher CPU and memory use. |

The dictation model row in `/voice` marks each choice as `Ready` or `Missing` and refuses to activate incomplete downloads.

## Configuration

### Voice preferences

`/voice` saves the dictation model, speech model, and selected Kitten voice in:

```text
~/.pi/agent/extensions/voice/config.json
```

The file contains the three selections:

```json
{
  "dictationModel": "whisper-tiny-en-int8",
  "ttsModel": "inflect-nano-v2-onnx",
  "voice": "expr-voice-3-f"
}
```

Set `PI_VOICE_CONFIG` before starting Pi to use a different config path:

```bash
export PI_VOICE_CONFIG="$HOME/.config/pi-voice.json"
```

Missing, malformed, and unknown values fall back to Moonshine Base, Kitten Nano, and `expr-voice-2-m`. Choosing a setting replaces its invalid value with a valid one.

### Model directory

Set `PI_VOICE_MODELS` before starting Pi:

```bash
export PI_VOICE_MODELS="$HOME/models/pi-voice"
```

The directory must contain each extracted model folder and, when used, `silero_vad.onnx` at its root.

### Recording source

The extension records from `default` unless `PI_VOICE_SOURCE` is set:

```bash
export PI_VOICE_SOURCE="alsa_input.usb-example.microphone"
```

Use `pactl list short sources` to find PipeWire/PulseAudio source names. Copy the source name exactly.

## Privacy and network use

The microphone stream never goes to a model provider. Transcription and Kitten speech synthesis use the local sherpa-onnx native addon. Inflect synthesis uses local ONNX Runtime and eSpeak-ng processes.

`/voice-speak` sends the latest assistant response to the global small model. `/voice-speak full` does not make a summary request and keeps the speech path local.

## Troubleshooting

### No recorder found

Install `alsa-utils` for `arecord`, or install ffmpeg. Check that at least one command is available:

```bash
command -v ffmpeg || command -v arecord
```

### Inflect reports that eSpeak is missing

Install `espeak-ng` and restart Pi:

```bash
sudo dnf install espeak-ng
```

### No playback command found

Install `pipewire-utils` for `pw-play`, or install ffmpeg for `ffplay`:

```bash
command -v pw-play || command -v ffplay
```

### The wrong microphone is used

Run `pactl list short sources`, set `PI_VOICE_SOURCE` to the desired source, and restart Pi.

### A model is reported as missing

Open `/voice` and compare the reported status with the expected extraction directory under `$PI_VOICE_MODELS`. The extension checks every required model file before activation.

### Spoken summaries fail before playback

Run `/small-model` and choose an authenticated text model. `/voice-speak full` can still use local synthesis when the global small model is unavailable.

## Pi APIs used

| API | Purpose |
|-----|---------|
| `pi.registerCommand()` | Registers settings, speech, and stop commands |
| `pi.on("session_start")` | Installs hold-to-dictate editor and terminal input handling |
| `pi.on("session_shutdown")` | Restores the previous editor and stops active work |
| `ctx.ui.custom()` | Displays the recording overlay |
| `ctx.ui.pasteToEditor()` | Inserts the finalized transcript |
| `ctx.ui.setEditorComponent()` | Wraps the active editor with hold-to-dictate handling |
| `ctx.ui.onTerminalInput()` | Handles Space hold sequences that bypass the editor |
| `ctx.ui.setStatus()` | Shows speech preparation and playback state |
| `ctx.sessionManager.getBranch()` | Finds the latest assistant response |
| `ctx.modelRegistry` | Selects summary models and resolves credentials |
| `completeSimple()` | Generates the short spoken summary |
