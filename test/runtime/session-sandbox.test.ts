import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startWorkerSandbox,
  type WorkerSandboxClient,
} from "../../extensions/worker-sandbox/src/client.ts";

let root: string | undefined;
let client: WorkerSandboxClient | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await client?.close();
  client = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "main-session OS sandbox",
  () => {
    it("enforces both flags through Pi's real command-line startup", async () => {
      root = await mkdtemp(join(tmpdir(), "pi-session-cli-test-"));
      const cwd = join(root, "repo");
      const reviews = join(root, "reviews");
      await mkdir(cwd);
      await mkdir(reviews);
      const source = join(cwd, "source");
      const result = join(reviews, "result");
      await writeFile(source, "unchanged");
      const provider = join(root, "probe.ts");
      await writeFile(
        provider,
        `
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default async function(pi) {
  const faux = fauxProvider({provider:"sandbox-probe",models:[{id:"probe",contextWindow:100000}],tokensPerSecond:1000000});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write",{path:${JSON.stringify(result)},content:"review"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("bash",{command:"printf cli-probe"}),{stopReason:"toolUse"}),
    fauxAssistantMessage(fauxToolCall("write",{path:${JSON.stringify(source)},content:"escape"}),{stopReason:"toolUse"}),
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
      const extension = (name: string) =>
        fileURLToPath(new URL(`../../extensions/${name}/${name}.ts`, import.meta.url));
      const run = promisify(execFile)(
        process.execPath,
        [
          cli,
          "--no-extensions",
          "--no-approve",
          "--no-skills",
          "--no-context-files",
          "-e",
          provider,
          "-e",
          extension("approval-mode"),
          "-e",
          extension("worker-sandbox"),
          "--approval-mode",
          "off",
          "--sandbox",
          JSON.stringify({
            network: { allowedDomains: [] },
            filesystem: { allowWrite: [reviews], denyWrite: [cwd] },
          }),
          "--model",
          "sandbox-probe/probe",
          "--no-session",
          "--mode",
          "json",
          "probe",
        ],
        {
          cwd,
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
      const { stdout, stderr } = await run.catch(
        (error: Error & { stdout?: string; stderr?: string }) => {
          throw new Error(`${error.message}\n${error.stdout?.slice(-5000)}\n${error.stderr}`);
        },
      );
      expect(stderr).toBe("");
      expect(await readFile(result, "utf8")).toBe("review");
      expect(await readFile(source, "utf8")).toBe("unchanged");
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_execution_end",
          toolName: "bash",
          isError: false,
          result: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining("cli-probe") }),
            ]),
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution_end", toolName: "write", isError: true }),
      );
    }, 40_000);

    it("reaches an explicitly allowed loopback HTTP daemon through the filtered proxy", async () => {
      root = await mkdtemp(join(tmpdir(), "pi-session-loopback-test-"));
      const cwd = root;
      const server = createServer((_request, response) => response.end("local-daemon"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing daemon port");
        vi.stubEnv("HUNK_MCP_PORT", String(address.port));
        client = await startWorkerSandbox(
          cwd,
          JSON.stringify({
            network: { allowedDomains: [`127.0.0.1:${address.port}`] },
            filesystem: {},
          }),
        );
        const chunks: Buffer[] = [];
        const result = await client.runShell("curl -fsS http://127.0.0.1:$HUNK_MCP_PORT", {
          cwd,
          timeout: 5,
          onData: (chunk) => chunks.push(chunk),
        });
        expect(result.exitCode).toBe(0);
        expect(Buffer.concat(chunks).toString()).toBe("local-daemon");
        const denied: Buffer[] = [];
        const blocked = await client.runShell(`curl -fsS http://localhost:${address.port}`, {
          cwd,
          timeout: 5,
          onData: (chunk) => denied.push(chunk),
        });
        expect(blocked.exitCode).not.toBe(0);
        expect(Buffer.concat(denied).toString()).toContain("403");
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 30_000);

    it("reads source, writes an outside review folder, and refuses other file and shell writes", async () => {
      root = await mkdtemp(join(tmpdir(), "pi-session-sandbox-test-"));
      const cwd = join(root, "repo");
      const reviews = join(root, "reviews");
      await mkdir(cwd);
      await mkdir(reviews);
      const source = join(cwd, "source");
      const outside = join(root, "outside");
      await writeFile(source, "unchanged");
      await writeFile(outside, "outside");
      client = await startWorkerSandbox(
        cwd,
        JSON.stringify({
          network: { allowedDomains: [] },
          filesystem: { allowWrite: [reviews], denyWrite: [cwd] },
        }),
      );
      const read = await client.runTool("read", { path: source }, { cwd });
      expect(read.content).toEqual([{ type: "text", text: "unchanged" }]);
      await client.runTool("write", { path: join(reviews, "result"), content: "review" }, { cwd });
      expect(await readFile(join(reviews, "result"), "utf8")).toBe("review");
      await expect(
        client.runTool("write", { path: source, content: "changed" }, { cwd }),
      ).rejects.toThrow();
      await expect(
        client.runTool("edit", { path: outside, oldText: "outside", newText: "changed" }, { cwd }),
      ).rejects.toThrow();
      // Capture the expected shell denial instead of allowing error output into the test log.
      const chunks: Buffer[] = [];
      const shell = await client.runShell(`printf changed > '${source}'`, {
        cwd,
        onData: (chunk) => chunks.push(chunk),
      });
      expect(shell.exitCode).not.toBe(0);
      expect(Buffer.concat(chunks).toString()).toMatch(/denied|permitted|read-only/i);
      expect(await readFile(source, "utf8")).toBe("unchanged");
      expect(await readFile(outside, "utf8")).toBe("outside");
    }, 30_000);
  },
);
