# Codex image generation

The `generate_image` tool creates and edits PNG images through Codex's hosted image-generation service. The agent can call it during a Pi session. There is no slash command or OpenAI API key fallback.

## Configuration

Run `codex login` first. The extension reads `auth.json` and `config.toml` from `$CODEX_HOME` or `~/.codex`. It uses `gpt-image-2` for the image tool. For the Codex chat model of the request, it uses Pi's current model when that model's provider is `openai-codex`. Otherwise it uses the `model` from `config.toml`, or `gpt-6.1-sol` if no model is configured. If Codex rejects a chat model for ChatGPT accounts, the tool tries the next model in that order, then `gpt-6.1-sol`. It tries each model one time. Expired tokens are refreshed in the Codex auth file.

The extension saves PNG files in the current project's Pi configuration directory, under `images/` (normally `./.pi/images/`). It adds that directory to the repository's local Git exclude file when applicable. It does not change the tracked `.gitignore`.

## Tool inputs

- `prompt` (required): describe the image or edit.
- `inputImages` (optional): up to five local PNG, JPEG, or WebP paths. Relative paths resolve from the current project directory.
- `size` (optional): dimensions accepted by the image model, such as `1024x1024`; default `auto`.
- `quality` (optional): `auto`, `low`, `medium`, or `high`; default `auto`.

The result contains the PNG path and image data. The tool also sends partial image previews while the Codex response streams. Generation may take a few minutes. Codex can return different dimensions than the requested `size`. Check the saved PNG when exact dimensions matter. Service availability, image model limits, and subscription limits come from Codex.

## Development

```bash
npm test -- --run test/extensions/codex-image*.test.ts
npm run validate:one -- extensions/codex-image/codex-image.ts
pi -e extensions/codex-image/codex-image.ts
```
