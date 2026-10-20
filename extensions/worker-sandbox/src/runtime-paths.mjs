import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

function packageRoot(name, from, optional) {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid runtime package name: ${name}`);
  const require = createRequire(from);
  for (const directory of require.resolve.paths(name) ?? []) {
    try {
      const root = realpathSync(join(directory, name));
      if (dirname(realpathSync(join(root, "package.json"))) !== root) throw new Error(`Runtime package manifest escapes its directory: ${name}`);
      return root;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  if (!optional) throw new Error(`Required runtime package is unavailable: ${name}`);
  return undefined;
}

/** Grant package roots, not their hoisting parent. Resolve dependencies as Node does from each real package. */
export function runtimePackageReadPaths(names, from = import.meta.url) {
  const paths = new Set();
  const pending = names.map((name) => ({ name, from, optional: false }));
  while (pending.length) {
    const request = pending.pop();
    const root = packageRoot(request.name, request.from, request.optional);
    if (!root || paths.has(root)) continue;
    paths.add(root);
    const file = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys(manifest.dependencies ?? {})) pending.push({ name, from: file, optional: Object.hasOwn(optional, name) });
    // Installed peers and platform-specific packages can load at runtime. Missing optional packages do not create grants.
    for (const name of new Set([...Object.keys(optional), ...Object.keys(manifest.peerDependencies ?? {})])) pending.push({ name, from: file, optional: true });
  }
  return [...paths].sort();
}
