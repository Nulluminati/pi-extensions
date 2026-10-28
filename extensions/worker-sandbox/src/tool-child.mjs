import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLocalBashOperations,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

const tools = {
  bash: createBashTool,
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
};

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Keys the sandbox owns: HOME, TMPDIR, and the cache root point at the
 *  sandbox scratch directory, so a request environment may not redirect them. */
const SANDBOX_OWNED_ENV = new Set(["HOME", "TMPDIR", "XDG_CACHE_HOME"]);

/** The command's environment: the sandbox's own environment (PATH, scratch
 *  home, locale) with the caller's shell environment layered on top. */
function commandEnvironment(requestEnv) {
  if (!requestEnv || typeof requestEnv !== "object") return undefined;
  const env = { ...process.env };
  for (const [key, value] of Object.entries(requestEnv)) {
    if (value === undefined || SANDBOX_OWNED_ENV.has(key)) continue;
    env[key] = value;
  }
  return env;
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (request.mainSession) {
    // srt bypasses the proxy for loopback by default. Main sessions send
    // loopback HTTP through the same explicit domain/port filter as the web.
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";
  }
  if (request.type === "shell") {
    const operations = createLocalBashOperations();
    const env = commandEnvironment(request.env);
    const result = await operations.exec(request.command, request.cwd, {
      onData: (chunk) => send({ type: "data", base64: Buffer.from(chunk).toString("base64") }),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(env ? { env } : {}),
    });
    send({ type: "result", value: result });
  } else if (request.type === "tool" && Object.hasOwn(tools, request.name)) {
    const factory = tools[request.name];
    const tool = factory(
      request.cwd,
      request.name === "bash" ? { exposeSessionEnvironment: false } : undefined,
    );
    const result = await tool.execute(
      request.id,
      request.params,
      undefined,
      (value) => send({ type: "update", value }),
      { cwd: request.cwd },
    );
    send({ type: "result", value: result });
  } else {
    throw new Error("Unknown sandbox tool request");
  }
} catch (error) {
  send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
