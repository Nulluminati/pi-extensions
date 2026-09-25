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

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (request.type === "shell") {
    const operations = createLocalBashOperations();
    const result = await operations.exec(request.command, request.cwd, {
      onData: (chunk) => send({ type: "data", base64: Buffer.from(chunk).toString("base64") }),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
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
      { cwd: request.cwd, model: request.model ? { input: request.model.input } : undefined },
    );
    send({ type: "result", value: result });
  } else {
    throw new Error("Unknown sandbox tool request");
  }
} catch (error) {
  send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
