/**
 * Package install behavior.
 *
 * `pi install git:...` clones the repo and runs `npm install --omit=dev`.
 * npm runs the `prepare` script during that install, but dev dependencies
 * such as husky are absent, so the script must succeed without them.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("package.json", () => {
  it("runs the prepare script without dev dependencies installed", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const prepare: unknown = pkg.scripts?.prepare;
    expect(typeof prepare).toBe("string");

    // A PATH without node_modules/.bin mirrors a production install.
    const result = spawnSync("sh", ["-c", String(prepare)], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
