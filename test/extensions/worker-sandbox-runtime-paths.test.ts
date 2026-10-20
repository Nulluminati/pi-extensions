import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimePackageReadPaths } from "../../extensions/worker-sandbox/src/runtime-paths.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-grants-"));
  roots.push(root);
  const from = join(root, "broker.mjs");
  await writeFile(from, "");
  return { root, from };
}
async function pkg(root: string, name: string, config: object = {}) {
  const path = join(root, "node_modules", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...config }),
  );
  return path;
}

describe("sandbox runtime package read grants", () => {
  it("includes installed transitive dependencies but never the node_modules parent or unrelated packages", async () => {
    const { root, from } = await fixture();
    const sdk = await pkg(root, "sdk", {
      dependencies: { "cross-spawn": "*" },
      optionalDependencies: { "absent-optional": "*" },
      peerDependencies: { "@peer/runtime": "*" },
    });
    const cross = await pkg(root, "cross-spawn", { dependencies: { which: "*", sdk: "*" } });
    const which = await pkg(root, "which");
    const peer = await pkg(root, "@peer/runtime");
    const unrelated = await pkg(root, "private-sibling");
    const paths = runtimePackageReadPaths(["sdk"], from);
    expect(paths).toEqual([sdk, cross, which, peer].sort());
    expect(paths).not.toContain(join(root, "node_modules"));
    expect(paths).not.toContain(root);
    expect(paths).not.toContain(unrelated);
  });
  it("resolves nested versions and symlinked package roots without widening their parent grants", async () => {
    const { root, from } = await fixture();
    const sdk = await pkg(root, "sdk", { dependencies: { dependency: "*" } });
    const nested = await pkg(sdk, "dependency");
    await pkg(root, "dependency");
    const physical = join(root, "linked-code");
    await mkdir(physical);
    await writeFile(
      join(physical, "package.json"),
      JSON.stringify({ name: "linked", version: "1.0.0" }),
    );
    await symlink(physical, join(root, "node_modules", "linked"));
    expect(runtimePackageReadPaths(["sdk", "linked"], from)).toEqual(
      [sdk, nested, physical].sort(),
    );
  });
  it("rejects a manifest symlink that would turn a package grant into a parent-directory grant", async () => {
    const { root, from } = await fixture();
    const sdk = join(root, "node_modules", "sdk");
    await mkdir(sdk, { recursive: true });
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify({ name: "sdk", version: "1.0.0" }));
    await symlink(outside, join(sdk, "package.json"));
    expect(() => runtimePackageReadPaths(["sdk"], from)).toThrow("manifest");
  });

  it("fails closed for missing required packages and invalid dependency names", async () => {
    const { root, from } = await fixture();
    await pkg(root, "sdk", { dependencies: { missing: "*" } });
    expect(() => runtimePackageReadPaths(["sdk"], from)).toThrow("missing");
    expect(() => runtimePackageReadPaths(["../private"], from)).toThrow("Invalid runtime package");
  });
});
