import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("applies --approval-reject block through Pi's real command-line startup", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-approval-cli-"));
  const fixture = join(root, "provider.ts");
  const marker = join(root, "must-not-exist");
  await writeFile(
    join(root, "herdboard.py"),
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("local module ran")\n`,
  );
  await writeFile(
    fixture,
    `
import {createProvider,fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default async function(pi) {
  pi.registerProvider(createProvider({
    id:"typesafe",
    auth:{apiKey:{name:"Offline classifier",resolve:async()=>({auth:{}})}},
    models:[{type:"classifier",provider:"typesafe",id:"jev-latest",name:"Offline Jev",api:"typesafe-system-one",input:["text"]}],
    classifiers:{"typesafe-system-one":{classify:async(model)=>({
      provider:"typesafe",model:model.id,api:"typesafe-system-one",timestamp:1,stopReason:"stop",
      answers:{harm:{type:"bool",probability:0.8},secrets:{type:"bool",probability:0.01},externalChange:{type:"bool",probability:0.01}}
    })}}
  }));
  const faux=fauxProvider({provider:"approval-probe",models:[{id:"probe",contextWindow:100000}],tokensPerSecond:1000000});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash",{command:${JSON.stringify(`printf must-not-run > '${marker}'`)}}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("bash",{command:"python3 -m herdboard show t8kr"}),{stopReason:"toolUse"}),
    fauxAssistantMessage("probe complete")
  ]);
  pi.registerProvider(faux.provider);
}`,
  );
  const cli = fileURLToPath(
    new URL(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      import.meta.url,
    ),
  );
  const extension = fileURLToPath(
    new URL("../../extensions/approval-mode/approval-mode.ts", import.meta.url),
  );
  const run = promisify(execFile)(
    process.execPath,
    [
      cli,
      "--no-extensions",
      "--no-approve",
      "--no-skills",
      "--no-context-files",
      "-e",
      fixture,
      "-e",
      extension,
      "--approval-reject",
      "block",
      "--model",
      "approval-probe/probe",
      "--no-session",
      "--mode",
      "json",
      "probe",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_OFFLINE: "1",
        PI_WORKER: "",
      },
      timeout: 30_000,
      maxBuffer: 2_000_000,
    },
  );
  run.child.stdin?.end();
  const { stdout, stderr } = await run;
  expect(stderr).toBe("");
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const toolResults = events.filter((event) => event.type === "tool_execution_end");
  expect(toolResults).toHaveLength(2);
  for (const result of toolResults)
    expect(result).toEqual(
      expect.objectContaining({
        type: "tool_execution_end",
        toolName: "bash",
        isError: true,
        result: expect.objectContaining({
          content: [
            {
              type: "text",
              text: "Approval Mode blocked: The command presents serious damage risk.",
            },
          ],
        }),
      }),
    );
}, 40_000);
