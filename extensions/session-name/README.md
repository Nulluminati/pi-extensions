# Session names

Unnamed interactive Pi sessions start with `Pi · project · short-id`. After the first user message, the global small model supplies a topic name.

The extension also works outside Herdr. Inside Herdr, the [Herdr extension](../herdr/README.md) copies the Pi name onto its owning pane.

## Usage

1. Enable this extension.
2. Use `/smallmodel` to select the global small model.
3. Start an unnamed interactive session.
4. Send the first user message.

The title request runs beside the main turn. It does not add messages to the conversation or change the active model.

Existing names and manual names remain unchanged. A manual rename cancels a pending title request.

Herdr mirrors both automatic and manual Pi names. It leaves parent tabs, workspaces, and the `Workers` tab unchanged.

## Configuration

Automatic naming starts enabled. Disable it for one session:

```bash
pi --session-name-disable
```

Model selection and credentials use the [global small-model configuration](../small-model/README.md), including its environment overrides and thinking level.

The extension does not run in worker, Remote Procedure Call (RPC), JavaScript Object Notation (JSON), print, or no-interface sessions.

## Limits and persistence

The request uses at most 8,000 characters from the first user message. Image-only messages use a generic image description.

Generated names contain one plain-text line, with at most 60 Unicode code points. The extension removes control characters.

Title requests have a 15-second timeout and no prompt-cache retention.

The output limit is 1,024 tokens with thinking enabled, or 256 otherwise. Reasoning tokens share this limit with the title text.

Configuration or credential errors keep the temporary name and report once per session. Later user messages retry model resolution until it succeeds. Naming still uses the first user message. Reload and resume can also retry these errors.

Provider errors and timeouts keep the temporary name and report one error. The extension does not retry these requests or select a fallback model.

The extension saves ownership and request outcome in `session-name:state` transcript entries. Reload and resume preserve generated, failed, and manual names.

An owned temporary name can resume its request after restart. A fork does not adopt another session's naming ownership.

Shutdown and session replacement cancel pending work. Late responses cannot rename a different session.

## Privacy

Naming sends the first message to the configured small-model provider. The title also appears in Pi history and, with Herdr enabled, the pane label.

The prompt tells the model to omit credentials and personal identifiers. This instruction cannot guarantee their removal. Disable automatic naming for sensitive sessions.
