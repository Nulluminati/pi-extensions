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
    writeFileSync(path, `sourcegraph commit: "${commit}", api_key: "${token}"\n`);
  }
  function scan(configPath, reportName) {
    const report = join(root, reportName);
    const result = spawnSync(
      process.env.GITLEAKS_BIN || "gitleaks",
      [
        "dir",
        "--no-banner",
        "--redact",
        "--config",
        configPath,
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
    return JSON.parse(readFileSync(report, "utf8"));
  }

  function findingFiles(findings, rule) {
    return findings
      .filter((finding) => finding.RuleID === rule)
      .map((finding) => finding.File.replace(`${root}/`, ""))
      .sort();
  }

  const controlConfig = join(root, "control.toml");
  writeFileSync(controlConfig, "[extend]\nuseDefault = true\n");
  const controlFindings = scan(controlConfig, "control-report.json");
  assert.deepEqual(
    findingFiles(controlFindings, "sourcegraph-access-token"),
    [...files].sort(),
    "Without exceptions, every fixture must activate the SHA detector",
  );
  assert.deepEqual(
    findingFiles(controlFindings, "github-pat"),
    [...files].sort(),
    "Without exceptions, every fixture must detect the synthetic token",
  );
  assert.equal(controlFindings.length, files.length * 2, "Control scan must detect both values");

  const findings = scan(config, "report.json");
  assert.deepEqual(
    findingFiles(findings, "github-pat"),
    [...files].sort(),
    "The SHA exception must not hide credentials on the same line",
  );
  assert.deepEqual(
    findingFiles(findings, "sourcegraph-access-token"),
    [],
    "The repository exception must suppress the synthetic SHA",
  );
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
  console.log("Secret scan regression tests passed (5 paths, control scan, and SHA exception).");
  console.log(
    "Ignore regression tests passed (environment files, evaluation data, and example files).",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
