import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../lib/git.ts";
import { processStartTime } from "../../lib/process-identity.ts";
import {
  capture,
  createEvaluationWorkspace,
  recoverCase,
  recoverWorkspace,
} from "../../scripts/virtual-models-eval/runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-virtual-runtime-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("isolated virtual-model evaluation runtime", () => {
  it("copies configuration, retains unrelated changes, and removes disposable worktrees", async () => {
    const root = await directory();
    const repository = join(root, "repo");
    const agentDir = join(root, "agent");
    await mkdir(repository);
    await mkdir(agentDir);
    await mkdir(join(repository, "node_modules"));
    await writeFile(join(repository, "tracked.txt"), "original");
    await runGit(repository, ["init", "--quiet"]);
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: seed isolated repository",
    ]);
    const commit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
    const settings = JSON.stringify({ packages: [repository], defaultTools: ["+codemode"] });
    await writeFile(join(agentDir, "settings.json"), settings);
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(join(repository, "tracked.txt"), "unrelated user change");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const workspace = await createEvaluationWorkspace(repository, commit);
    const cwd = workspace.cwd;
    let recovered = false;
    try {
      const isolated = JSON.parse(
        await readFile(join(workspace.agentDir, "settings.json"), "utf8"),
      );
      expect(isolated.packages).toContain(repository);
      expect(isolated.defaultTools).toEqual(["-codemode"]);
      expect(
        JSON.parse(
          await readFile(join(workspace.agentDir, "virtual-worker-extensions.json"), "utf8"),
        ),
      ).toContain("virtual-models");
      await workspace.reset("on", "inventory");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("original");
      expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("unrelated user change");
      expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(settings);
      const prefix = join(root, "recovered");
      await writeFile(
        `${prefix}.setup.json`,
        JSON.stringify({ cwd, agentDir: workspace.agentDir }),
      );
      recovered = await recoverWorkspace(prefix, repository);
      expect(recovered).toBe(true);
      expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("unrelated user change");
    } finally {
      if (!recovered) await workspace.dispose();
    }
    expect((await runGit(repository, ["worktree", "list", "--porcelain"])).includes(cwd)).toBe(
      false,
    );
  });
  it("stops only the recorded process identity before an interrupted case resumes", async () => {
    const cwd = await directory();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},30000)"], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((done) =>
      child.once("close", (code, signal) => done({ code, signal })),
    );
    cleanups.push(async () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      await exited;
    });
    if (!child.pid) throw new Error("No test child");
    const stamp = await processStartTime(child.pid);
    const prefix = join(cwd, "recovery");
    await writeFile(
      `${prefix}.process.json`,
      JSON.stringify({ pid: child.pid, processStartedAt: stamp, cwd }),
    );
    expect(await recoverCase(prefix)).toBe("stopped");
    expect(await exited).toMatchObject({ signal: "SIGKILL" });
    expect(await recoverCase(prefix)).toBe("gone");
  });

  it("captures completed usage from raw events and retains raw output before a timeout", async () => {
    const cwd = await directory();
    const command = join(cwd, "fake-pi");
    await writeFile(
      command,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",provider:"zai",model:"glm-5.3-flash",timestamp:1,content:[{type:"text",text:"done"}],stopReason:"stop",usage:{input:10,output:2,totalTokens:12}}}));console.log(JSON.stringify({type:"agent_settled",aborted:false}));`,
    );
    await chmod(command, 0o700);
    const completed = await capture({
      cwd,
      agentDir: cwd,
      model: "zai/glm-5.3-flash",
      workerModel: "zai/glm-5.3-flash",
      prompt: "test",
      prefix: join(cwd, "complete"),
      timeoutMs: 5000,
      command,
    });
    expect(completed.main.usage.aggregate).toBe(12);
    expect(completed.main.settled).toBe(true);
    expect(completed.timedOut).toBe(false);
    expect(completed.stderr).toBe("");
    expect(JSON.parse(await readFile(join(cwd, "complete.process.json"), "utf8"))).toMatchObject({
      pid: expect.any(Number),
      deadlineAt: expect.any(Number),
    });
    await writeFile(
      command,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_start",message:{role:"assistant"}}));setTimeout(()=>{},30000);`,
    );
    const interrupted = await capture({
      cwd,
      agentDir: cwd,
      model: "zai/glm-5.3-flash",
      workerModel: "zai/glm-5.3-flash",
      prompt: "test",
      prefix: join(cwd, "timeout"),
      timeoutMs: 500,
      command,
    });
    expect(interrupted.timedOut).toBe(true);
    expect(interrupted.main.usage.aggregate).toBeNull();
    expect(await readFile(join(cwd, "timeout.events.jsonl"), "utf8")).toContain("message_start");
  });
});
