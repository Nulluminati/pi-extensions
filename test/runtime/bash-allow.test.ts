import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  type ExtensionAPI,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import backgroundJobsExtension from "../../extensions/background-jobs/background-jobs.ts";
import bashAllowExtension from "../../extensions/bash-allow/bash-allow.ts";
import { createPiSession, type PiSession } from "../harness/pi-session.ts";

async function registerRealBash(pi: ExtensionAPI): Promise<void> {
  // The harness disables built-ins. Register Pi's real implementation,
  // but resolve its working directory from the executing session.
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) => {
      const shellPath = pi.getSettings().shellPath;
      return createBashToolDefinition(ctx.cwd, shellPath ? { shellPath } : {}).execute(
        id,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}

let harness: PiSession | undefined;
afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  vi.unstubAllEnvs();
});

it("blocks an unlisted real bash call and executes a listed call", async () => {
  vi.stubEnv("PI_BASH_ALLOW", "printf:*");
  harness = await createPiSession({
    extensions: [bashAllowExtension, registerRealBash],
    responses: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "touch denied" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf allowed" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ],
  });
  await harness.session.prompt("run both commands");
  expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject(
    [
      {
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Allowed: printf:*") }],
      },
      { toolName: "bash", isError: false, content: [{ type: "text", text: "allowed" }] },
    ],
  );
  expect(existsSync(join(harness.cwd, "denied"))).toBe(false);
});

it.each([{ env: { GH_BROWSER: "printf injected" } }, { cwd: "/outside" }])(
  "blocks real background calls with overrides: %j",
  async (extra) => {
    vi.stubEnv("PI_BASH_ALLOW", "printf:*");
    harness = await createPiSession({
      extensions: [bashAllowExtension, backgroundJobsExtension],
      responses: [
        fauxAssistantMessage(fauxToolCall("background", { command: "printf allowed", ...extra }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ],
    });
    await harness.session.prompt("run the background command");
    expect(
      harness.session.messages.filter((message) => message.role === "toolResult"),
    ).toMatchObject([
      {
        toolName: "background",
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("bash-allow blocks background") }],
      },
    ]);
  },
);

it("blocks an unlisted real monitor and executes a listed monitor", async () => {
  initTheme("dark", false);
  vi.stubEnv("PI_BASH_ALLOW", "touch:*");
  harness = await createPiSession({
    extensions: [bashAllowExtension, backgroundJobsExtension],
    responses: [
      fauxAssistantMessage(
        fauxToolCall("monitor", {
          command: "mkdir denied-monitor",
          satisfy_on: "exit_zero",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("monitor", {
          command: "touch allowed-monitor",
          satisfy_on: "exit_zero",
          interval_seconds: 1,
          timeout_seconds: 10,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("started"),
      fauxAssistantMessage("monitor completed"),
    ],
  });
  await harness.session.prompt("run both monitors");
  await expect
    .poll(() =>
      harness?.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "background-jobs")
        .at(-1),
    )
    .toMatchObject({ data: { jobs: [{ kind: "monitor", status: "satisfied" }] } });
  await harness.session.waitForIdle();
  expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject(
    [
      {
        toolName: "monitor",
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Allowed: touch:*") }],
      },
      {
        toolName: "monitor",
        isError: false,
        content: [{ type: "text", text: expect.stringContaining("Started monitor #") }],
        details: { satisfyOn: "exit_zero", intervalSeconds: 1, timeoutSeconds: 10 },
      },
    ],
  );
  expect(existsSync(join(harness.cwd, "denied-monitor"))).toBe(false);
  expect(existsSync(join(harness.cwd, "allowed-monitor"))).toBe(true);
  expect(
    harness.session.messages.filter(
      (message) => message.role === "assistant" && message.stopReason === "error",
    ),
  ).toEqual([]);
});

it("blocks Bash-quoted input before an unsupported shell can interpret it", async () => {
  vi.stubEnv("PI_BASH_ALLOW", "echo:*");
  harness = await createPiSession({
    extensions: [bashAllowExtension, registerRealBash],
    settings: { shellPath: "/usr/bin/fish" },
    responses: [
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: String.raw`echo 'a\'' ; printf marker ; echo \'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ],
  });
  await harness.session.prompt("run the command");
  expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject(
    [
      {
        toolName: "bash",
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("Unsupported shellPath: /usr/bin/fish") },
        ],
      },
    ],
  );
});

it("leaves user ! commands unrestricted in a gated session", async () => {
  vi.stubEnv("PI_BASH_ALLOW", "pwd:*");
  harness = await createPiSession({ extensions: [bashAllowExtension] });
  const result = await harness.session.executeBash("printf user-command");
  expect(result).toMatchObject({ output: "user-command", exitCode: 0, cancelled: false });
});

it("runs model shell calls without a configured list", async () => {
  vi.stubEnv("PI_BASH_ALLOW", undefined);
  harness = await createPiSession({
    extensions: [bashAllowExtension, registerRealBash],
    responses: [
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf unrestricted" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ],
  });
  await harness.session.prompt("run a shell command");
  expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject(
    [{ toolName: "bash", isError: false, content: [{ type: "text", text: "unrestricted" }] }],
  );
});
