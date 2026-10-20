import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxToolCall,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import backgroundJobsExtension from "../../extensions/background-jobs/background-jobs.ts";
import todosExtension from "../../extensions/todos/todos.ts";
import { TODOS_ENTRY_TYPE } from "../../lib/todos.ts";
import { createPiSession, type PiSession } from "../harness/pi-session.ts";

let harness: PiSession | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function callTool(name: string, args: ToolCall["arguments"]): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function toolResults(session: PiSession["session"]) {
  return session.messages.filter((message) => message.role === "toolResult");
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("todos in a real Pi session", () => {
  it("adds items through the tool and persists them as a session entry", async () => {
    harness = await createPiSession({
      extensions: [todosExtension],
      responses: [
        callTool("todo", { action: "add", items: ["write tests", "ship"] }),
        fauxAssistantMessage("done"),
      ],
    });

    await harness.session.prompt("plan the work");

    expect(toolResults(harness.session)).toMatchObject([
      {
        toolName: "todo",
        isError: false,
        content: [{ type: "text", text: "Added 2 item(s):\n1. ☐ write tests\n2. ☐ ship" }],
      },
    ]);
    const persisted = harness.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === TODOS_ENTRY_TYPE);
    expect(persisted.at(-1)).toMatchObject({
      data: {
        items: [
          { text: "write tests", completed: false },
          { text: "ship", completed: false },
        ],
      },
    });
  });

  it("restores persisted items on session_start", async () => {
    harness = await createPiSession({
      extensions: [todosExtension],
      setup: (sessionManager) => {
        sessionManager.appendCustomEntry(TODOS_ENTRY_TYPE, {
          items: [{ text: "carried over", completed: true }],
        });
      },
      responses: [callTool("todo", { action: "list" }), fauxAssistantMessage("done")],
    });

    await harness.session.prompt("what is left?");

    expect(toolResults(harness.session)).toMatchObject([
      { toolName: "todo", content: [{ type: "text", text: "1. ☑ carried over" }] },
    ]);
  });
});

describe("background-jobs in a real Pi session", () => {
  it("stops running jobs on session_shutdown", async () => {
    harness = await createPiSession({
      extensions: [backgroundJobsExtension],
      responses: [
        callTool("background", { command: "sleep 30", label: "sleeper" }),
        fauxAssistantMessage("started"),
      ],
    });
    await harness.session.prompt("start a long job");
    const [started] = toolResults(harness.session);
    const pid = (started?.details as { pid?: number } | undefined)?.pid;
    if (pid === undefined) throw new Error("background tool returned no pid");
    expect(processIsGone(pid)).toBe(false);

    await harness.shutdown();

    await expect.poll(() => processIsGone(pid), { timeout: 5_000 }).toBe(true);
  });
});
