import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-secret-scan-"));
const config = resolve(".gitleaks.toml");
const files = [
  "README.md",
  "extensions/example/README.md",
  ".github/workflows/example.yml",
  "src/example.ts",
  "test/extensions/code-search.test.ts",
];
// Construct a synthetic token so this test source contains no complete credential.
const token = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const commit = "48c6663a66b7eacbd9c7c411863ab5d18dbeea88";

try {
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `commit: "${commit}", api_key: "${token}"\n`);
  }
  writeFileSync(join(root, "placeholders.md"), "syn_... ctx7sk-... sk-... PLACEHOLDER\n");
  const report = join(root, "report.json");
  const result = spawnSync(
    process.env.GITLEAKS_BIN || "gitleaks",
    [
      "dir",
      "--no-banner",
      "--redact",
      "--config",
      config,
      "--report-format",
      "json",
      "--report-path",
      report,
      root,
    ],
    { encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, `Expected detected secrets. Scanner output:\n${result.stderr}`);
  const findings = JSON.parse(readFileSync(report, "utf8"));
  const tokenFiles = findings
    .filter((finding) => finding.RuleID === "github-pat")
    .map((finding) => finding.File.replace(`${root}/`, ""))
    .sort();
  assert.deepEqual(tokenFiles, [...files].sort(), "Every path must detect the synthetic token");
  assert.equal(findings.length, files.length, "Only synthetic tokens must produce findings");
  writeFileSync(join(root, ".gitignore"), readFileSync(".gitignore"));
  const init = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.ifError(init.error);
  assert.equal(init.status, 0, init.stderr);
  const ignoredPaths = [
    ".env",
    ".env.production",
    ".pi/virtual-models-eval/run/baseline.json",
    ".pi/virtual-models-task/graph.json",
  ];
  const ignored = spawnSync(
    "git",
    [
      "-C",
      root,
      "check-ignore",
      "--no-index",
      ...ignoredPaths,
      ".env.example",
      ".env.production.example",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
  assert.ifError(ignored.error);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split("\n"), ignoredPaths);
  console.log("Secret scan regression tests passed (5 paths, placeholders, and fake commit SHA).");
  console.log(
    "Ignore regression tests passed (environment files, evaluation data, and example files).",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
