import { registerHooks } from "node:module";

const stubs = new Map([
  ["@anthropic-ai/sandbox-runtime", new URL("./worker-sandbox-manager-stub.mjs", import.meta.url).href],
  ["@earendil-works/pi-coding-agent", new URL("./worker-sandbox-tools-stub.mjs", import.meta.url).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubs.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
