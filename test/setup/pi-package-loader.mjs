/**
 * Module resolve hook mapping `@earendil-works/pi-coding-agent` to a local stub
 * for subprocesses spawned by tests.
 *
 * Load it *after* tsx so its hook runs first (Node calls registered resolve
 * hooks in reverse order): `--import tsx --import ./test/setup/pi-package-loader.mjs`.
 * Without the ordering, tsx throws ERR_MODULE_NOT_FOUND before delegating.
 */

import { registerHooks } from "node:module";

const STUB_URL = new URL("./pi-coding-agent-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
