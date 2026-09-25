import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const helper = fileURLToPath(new URL("./tool-child.mjs", import.meta.url));
const running = new Map();
let ready = false;
let cwd;
let policy;
let scratch;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function stop(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readGrantForPackage(name) {
  const entrypoint = fileURLToPath(import.meta.resolve(name));
  return dirname(dirname(entrypoint));
}

function safeEnvironment() {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: scratch,
    TMPDIR: scratch,
    XDG_CACHE_HOME: join(scratch, "cache"),
  };
  for (const key of ["LANG", "LC_ALL", "TERM", "TZ", "NO_COLOR", "CI"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function initialize(request) {
  if (ready) throw new Error("Worker sandbox already initialized");
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Worker sandbox does not support ${process.platform}`);
  }
  cwd = request.cwd;
  scratch = request.scratch;
  mkdirSync(join(scratch, "cache"), { recursive: true });
  // The broker itself is outside the worktree. Runtime code and the host
  // toolchain are read-only exceptions to the project's home read-deny.
  const executableDir = dirname(process.execPath);
  const executablePrefix = dirname(executableDir);
  const toolchain = executablePrefix === "/usr" ? executableDir : executablePrefix;
  policy = {
    ...request.policy,
    network: { ...request.policy.network, allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: {
      ...request.policy.filesystem,
      allowRead: [
        ...request.policy.filesystem.allowRead,
        scratch,
        dirname(helper),
        readGrantForPackage("@anthropic-ai/sandbox-runtime"),
        readGrantForPackage("@earendil-works/pi-coding-agent"),
        toolchain,
      ],
      allowWrite: [...request.policy.filesystem.allowWrite, scratch],
    },
  };
  await SandboxManager.initialize(policy);
  ready = true;
  send({ type: "ready" });
}

async function execute(request) {
  const { id } = request;
  if (!ready) {
    send({ type: "error", id, error: "Worker sandbox not ready" });
    return;
  }
  if (request.type === "tool" && !["read", "write", "edit", "bash", "ls", "find", "grep"].includes(request.name)) {
    send({ type: "error", id, error: "Unknown worker sandbox tool" });
    return;
  }
  let child;
  try {
    const proxyPaths = process.platform === "linux"
      ? [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter(Boolean)
      : [];
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      `${shellQuote(process.execPath)} ${shellQuote(helper)}`,
      undefined,
      {
        filesystem: {
          ...policy.filesystem,
          allowRead: [...policy.filesystem.allowRead, ...proxyPaths],
        },
      },
      undefined,
      cwd,
      { commandId: String(id), commandText: request.type === "tool" ? request.name : "user bash" },
    );
    // srt's returned env contains the entire broker environment on Unix.
    // The wrapper itself supplies proxy settings, so do not pass that env
    // (which may contain model credentials) into the sandboxed process.
    child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd,
      env: safeEnvironment(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    send({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  running.set(id, child);
  let done = false;
  let stderr = "";
  const timeout = request.timeout && request.timeout > 0
    ? setTimeout(() => {
        if (done) return;
        done = true;
        stop(child);
        send({ type: "error", id, error: `Command timed out after ${request.timeout}s` });
      }, request.timeout * 1000)
    : undefined;
  const finish = (reply) => {
    if (done) return;
    done = true;
    if (timeout) clearTimeout(timeout);
    send({ ...reply, id });
  };
  child.stderr?.on("data", (data) => {
    stderr = `${stderr}${data.toString()}`.slice(-2000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      finish({ type: "error", error: "Worker sandbox tool sent invalid output" });
      stop(child);
      return;
    }
    if (response.type === "update" || response.type === "data") {
      if (!done) send({ ...response, id });
    } else if (response.type === "result") {
      finish({ type: "result", value: response.value });
    } else if (response.type === "error") {
      finish({ type: "error", error: response.error });
    } else {
      finish({ type: "error", error: "Worker sandbox tool sent an unknown response" });
      stop(child);
    }
  });
  child.on("error", (error) => finish({ type: "error", error: error.message }));
  child.on("close", (code) => {
    if (timeout) clearTimeout(timeout);
    running.delete(id);
    if (!done) finish({ type: "error", error: `Worker sandbox tool exited (${code}): ${stderr.trim()}` });
  });
  child.stdin?.on("error", (error) => finish({ type: "error", error: error.message }));
  child.stdin?.end(JSON.stringify({ ...request, cwd }));
}

async function shutdown() {
  ready = false;
  for (const child of running.values()) stop(child);
  running.clear();
  await SandboxManager.reset();
}

try {
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error("Worker sandbox broker received invalid JSON");
    }
    if (request.type === "init") {
      await initialize(request);
    } else if (request.type === "shutdown") {
      break;
    } else if (request.type === "cancel") {
      const child = running.get(request.id);
      if (child) stop(child);
    } else if (request.type === "tool" || request.type === "shell") {
      void execute(request).catch((error) => {
        send({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }
} catch (error) {
  send({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await shutdown();
}
