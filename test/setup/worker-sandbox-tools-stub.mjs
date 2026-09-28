import { spawn } from "node:child_process";

function makeTool(name) {
  return () => ({
    async execute(_id, params, _signal, onUpdate, ctx) {
      const descendant = params.mode === "hang"
        ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
        : undefined;
      onUpdate({ phase: "started", pid: process.pid, descendantPid: descendant?.pid, cwd: ctx.cwd });
      if (params.mode === "hang") {
        await new Promise(() => setInterval(() => {}, 1_000));
      }
      if (params.mode === "malformed") {
        process.stdout.write("not json\n");
        await new Promise(() => setInterval(() => {}, 1_000));
      }
      if (params.mode === "error") throw new Error("test tool failed");
      return { content: [{ type: "text", text: `${name}:${params.path ?? ""}` }] };
    },
  });
}

export const createBashTool = makeTool("bash");
export const createReadTool = makeTool("read");
export const createWriteTool = makeTool("write");
export const createEditTool = makeTool("edit");
export const createFindTool = makeTool("find");
export const createGrepTool = makeTool("grep");
export const createLsTool = makeTool("ls");

export function createLocalBashOperations() {
  return {
    async exec(_command, _cwd, options) {
      options.onData(Buffer.from([0, 255]));
      return { exitCode: 0, stdout: "stub", stderr: "" };
    },
  };
}
