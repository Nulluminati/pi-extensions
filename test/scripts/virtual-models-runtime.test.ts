import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktree, removeWorktree } from "../../extensions/workers/src/worktree.ts";
import { runGit } from "../../lib/git.ts";
import { processStartTime } from "../../lib/process-identity.ts";
import {
  capture,
  createEvaluationWorkspace,
  prepareTaskWorkspace,
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
    vi.mocked(getAgentDir).mockReturnValueOnce(agentDir);
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
  it("commits only disposable isolated-worker setup so the real clean-tree guard accepts the injected bug", async () => {
    const root = await directory();
    const cwd = join(root, "repo");
    const dependencies = join(root, "dependencies");
    await mkdir(join(cwd, "lib"), { recursive: true });
    await mkdir(dependencies);
    const source =
      'export function isArrowLeft(data: string) { return data === "\\u001b[D" || data === "\\u001bOD"; }\n';
    await writeFile(join(cwd, "lib/arrow-keys.ts"), source);
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await runGit(cwd, ["init", "--quiet"]);
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: seed source",
    ]);
    await symlink(dependencies, join(cwd, "node_modules"));
    const prepared = await prepareTaskWorkspace(
      cwd,
      { role: "worker", task: "fix" },
      { "lib/arrow-keys.ts": source },
    );
    expect(prepared.seeded).toBe(true);
    expect((await runGit(cwd, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toContain("/node_modules");
    const child = await createWorktree(cwd, "w-fixture-clean");
    try {
      expect(await readFile(join(child.path, "lib/arrow-keys.ts"), "utf8")).toContain(
        '"\\u001bOC"',
      );
      expect((await runGit(child.path, ["rev-parse", "HEAD"])).trim()).toBe(prepared.setupCommit);
    } finally {
      await removeWorktree(cwd, "w-fixture-clean");
    }
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
