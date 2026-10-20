import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSession, type PiSession } from "../harness/pi-session.ts";

let harness: PiSession | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function echoExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "echo",
    label: "Echo",
    description: "Return the given text.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `echo: ${params.text}` }], details: undefined };
    },
  });
}

describe("in-memory Pi session harness", () => {
  it("runs an inline extension tool through a scripted model turn", async () => {
    harness = await createPiSession({
      extensions: [echoExtension],
      responses: [
        fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ],
    });

    await harness.session.prompt("say hi");

    const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      toolName: "echo",
      content: [{ type: "text", text: "echo: hi" }],
    });
    expect(harness.requests).toHaveLength(2);
    expect(JSON.stringify(harness.requests[1]?.messages)).toContain("echo: hi");
  });

  it("keeps Pi state in a temporary directory", async () => {
    harness = await createPiSession({ responses: [fauxAssistantMessage("done")] });
    const { cwd } = harness;

    expect(cwd.startsWith(homedir())).toBe(false);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(cwd);

    harness.dispose();
    harness = undefined;

    expect(existsSync(cwd)).toBe(false);
    expect(process.env.PI_CODING_AGENT_DIR).not.toBe(cwd);
    expect(existsSync(join(cwd, "auth.json"))).toBe(false);
  });
});
