/**
 * Strip Pi worker-session variables before every test file loads.
 *
 * The suite must behave the same inside a Pi worker shell as on the host:
 * gate behavior is exercised with vi.stubEnv inside the tests that need it,
 * and no test may inherit the ambient session instead.
 */
for (const key of [
  "PI_WORKER",
  "PI_MESSENGER_NAME",
  "PI_WORKER_STREAM",
  // Worker-extension allowlist: resolves extensions/<name>/<name>.ts. Tests
  // must exercise the default set against THIS repo's extensions; a stale
  // parent value (or one naming an extension removed by a refactor under
  // test) breaks isolation assumptions.
  "PI_WORKER_EXTENSIONS",
]) {
  delete process.env[key];
}
