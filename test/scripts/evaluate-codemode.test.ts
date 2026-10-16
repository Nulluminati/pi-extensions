import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../../lib/git.ts";
import { aggregateRuns, JsonlMetrics } from "../../scripts/codemode-evaluation/metrics.ts";
import {
  captureRun,
  checkRename,
  createWorkspace,
  referenceTestCount,
} from "../../scripts/codemode-evaluation/runtime.ts";
import {
  checkAnswer,
  deriveExpectations,
  parseAnswer,
  taskPrompts,
  validateReferenceCounts,
} from "../../scripts/codemode-evaluation/tasks.ts";
import { parseOptions } from "../../scripts/evaluate-codemode.ts";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sampleMetrics() {
  const parser = new JsonlMetrics();
  parser.push(line({ type: "agent_settled", aborted: false }));
  return parser.finish();
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});

describe("codemode evaluation workspace", () => {
  it("accepts the known dependency link but rejects other untracked files and link targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "codemode-rename-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dependencies = resolve(import.meta.dirname, "../../node_modules");
    const original = "export function isNodeError() { return true; }\n";
    await symlink(dependencies, join(root, "node_modules"));
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await writeFile(join(root, "helper.ts"), original);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", types: [] }, include: ["helper.ts"] }),
    );
    await runGit(root, ["init", "--quiet"]);
    await runGit(root, ["add", "--", ".gitignore", "helper.ts", "tsconfig.json"]);
    await runGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: add rename fixture",
    ]);
    await writeFile(join(root, "helper.ts"), original.replace("isNodeError", "hasNodeErrorCode"));
    expect(await checkRename(root, { "helper.ts": original }, dependencies)).toMatchObject({
      renameExact: true,
      typecheckPassed: true,
    });
    await writeFile(join(root, "extra.ts"), "export const extra = true;\n");
    expect(await checkRename(root, { "helper.ts": original }, dependencies)).toMatchObject({
      renameExact: false,
      typecheckPassed: true,
    });
    await rm(join(root, "extra.ts"));
    await mkdir(join(root, "other-dependencies"));
    expect(
      await checkRename(root, { "helper.ts": original }, join(root, "other-dependencies")),
    ).toMatchObject({ renameExact: false, typecheckPassed: true });
  });

  it("distinguishes a task timeout from a setup failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "codemode-timeout-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fakePi = join(root, "pi");
    await writeFile(fakePi, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 2000);\n");
    await chmod(fakePi, 0o755);
    vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
    const result = await captureRun({
      cwd: root,
      agentDir: root,
      model: "example/test",
      arm: "off",
      prompt: "test",
      outputPrefix: join(root, "run"),
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Run exceeded 50ms");
    expect(result.wallMs).toBeLessThan(2000);
  });

  it("stops the detached Pi child when the runner receives a termination signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codemode-signal-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fakePi = join(root, "pi");
    await writeFile(fakePi, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 2000);\n");
    await chmod(fakePi, 0o755);
    const source = `import { captureRun } from ${JSON.stringify(resolve(import.meta.dirname, "../../scripts/codemode-evaluation/runtime.ts"))};
      const pending = captureRun({cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(root)}, model: "example/test", arm: "off", prompt: "test", outputPrefix: ${JSON.stringify(join(root, "run"))}, timeoutMs: 5000});
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
      const result = await pending; console.log(JSON.stringify({error: result.error, wallMs: result.wallMs}));`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
        timeout: 7000,
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ error: "Evaluation interrupted" });
    expect(JSON.parse(result.stdout).wallMs).toBeLessThan(2000);
    expect(result.stderr).toBe("");
  });

  it("reads the real Vitest JSON report instead of its stdout notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "codemode-report-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "test", "extensions"), { recursive: true });
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(root, "node_modules"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(root, "test", "extensions", "todos.test.ts"),
      'import { expect, it } from "vitest"; it.each([1, 2])("sample %i", (value) => { expect(value).toBeGreaterThan(0); });',
    );
    expect(await referenceTestCount(root)).toBe(2);
  });

  it("keeps dependencies available after every clean reset and isolates arm settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "codemode-eval-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "repository");
    const agentDir = join(root, "agent");
    await mkdir(join(repository, "node_modules"), { recursive: true });
    await mkdir(join(repository, "test", "extensions"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(repository, "node_modules", "marker"), "locked dependency");
    await writeFile(join(repository, "test", "extensions", "fixture.ts"), "baseline");
    await mkdir(join(repository, ".pi", "skills"), { recursive: true });
    await writeFile(join(repository, ".pi", "skills", "fixture.md"), "tracked skill");
    await writeFile(
      join(repository, ".gitignore"),
      "node_modules/\nsettings.json\n.pi/messenger/\n",
    );
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [repository] }));
    await runGit(repository, ["init", "--quiet"]);
    await runGit(repository, ["add", "."]);
    await runGit(repository, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: add evaluation fixture",
    ]);
    const commit = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const workspace = await createWorkspace(repository, commit);
    cleanups.push(() => workspace.dispose());
    for (const arm of ["only", "off", "on"]) {
      await writeFile(join(workspace.cwd, "test", "extensions", "fixture.ts"), "edited");
      await writeFile(join(workspace.cwd, "untracked.txt"), "leftover");
      await mkdir(join(workspace.cwd, ".pi", "messenger"), { recursive: true });
      await writeFile(
        join(workspace.cwd, ".pi", "messenger", "reservations.json"),
        "stale reservation",
      );
      await workspace.reset(arm, "inventory");
      await expect(
        readFile(join(workspace.cwd, ".pi", "messenger", "reservations.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(workspace.cwd, ".pi", "skills", "fixture.md"), "utf8")).toBe(
        "tracked skill",
      );
      expect(await readFile(join(workspace.cwd, "node_modules", "marker"), "utf8")).toBe(
        "locked dependency",
      );
      expect(await readFile(join(workspace.cwd, "test", "extensions", "fixture.ts"), "utf8")).toBe(
        "baseline",
      );
      await expect(readFile(join(workspace.cwd, "untracked.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (arm === "only") {
        expect(
          JSON.parse(await readFile(join(workspace.cwd, ".pi", "settings.json"), "utf8")),
        ).toEqual({ codemode: { mode: "only" } });
      } else {
        await expect(readFile(join(workspace.cwd, ".pi", "settings.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({
      packages: [repository],
    });
  });
});

describe("codemode evaluation options", () => {
  it("defaults to the agreed full matrix", () => {
    const options = parseOptions([]);
    expect(options.tasks).toHaveLength(8);
    expect(options.arms).toEqual(["off", "on", "only"]);
    expect(options.models).toEqual(["openai-codex/gpt-6.1-sol", "opencode-go/glm-5.3"]);
    expect(options.runs).toBe(3);
  });

  it("selects a partial run without changing the defaults", () => {
    expect(
      parseOptions([
        "--tasks",
        "inventory",
        "--arms",
        "on,only",
        "--models",
        "example/test",
        "--runs",
        "1",
        "--commit",
        "abc",
        "--timeout-seconds",
        "20",
      ]),
    ).toMatchObject({
      tasks: ["inventory"],
      arms: ["on", "only"],
      models: ["example/test"],
      runs: 1,
      commit: "abc",
      timeoutMs: 20_000,
    });
  });

  it.each([
    ["--runs", "0"],
    ["--runs", "1.5"],
    ["--tasks", "missing"],
    ["--arms", "off,on,on"],
    ["--models", ""],
    ["--runs"],
    ["--unknown", "x"],
    ["--runs", "1", "--runs", "2"],
  ])("rejects invalid options %j", (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });
});

describe("codemode evaluation metrics", () => {
  it("splits only on LF across chunks and preserves Unicode separators", () => {
    const parser = new JsonlMetrics();
    const text = "Zero Cool\u2028one\u2029two";
    const input = line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        provider: "example",
        model: "test",
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.2 } },
      },
    }).replace(/\n$/, "\r\n");
    parser.push(input.slice(0, 13));
    parser.push(input.slice(13, 47));
    parser.push(input.slice(47));
    parser.push(line({ type: "agent_settled", aborted: false }));
    expect(parser.finish()).toMatchObject({
      finalText: text,
      stopReason: "stop",
      settled: true,
      aborted: false,
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 20,
      cost: 0.2,
      models: ["example/test"],
    });
  });

  it("counts authoritative messages once, including parent nested usage", () => {
    const parser = new JsonlMetrics();
    parser.push(line({ type: "message_update", usage: { input: 999, output: 999 } }));
    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", name: "codemode", arguments: "return 1" },
        { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
      ],
      usage: { input: 10, output: 4, cost: { total: 0.1 } },
    };
    parser.push(line({ type: "message_end", message }));
    parser.push(
      line({
        type: "tool_execution_start",
        toolName: "bash",
        parentToolCallId: "c1",
        args: { command: "npx vitest run test/extensions/todos.test.ts" },
      }),
    );
    parser.push(
      line({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "codemode",
          isError: true,
          usage: { input: 3, output: 1, cost: { total: 0.02 } },
          nestedCalls: {
            calls: [
              { name: "bash", status: "ok" },
              { name: "read", status: "error" },
            ],
            complete: false,
          },
        },
      }),
    );
    parser.push(line({ type: "agent_end", messages: [message] }));
    parser.push(
      line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        },
      }),
    );
    parser.push(line({ type: "agent_settled", aborted: false }));
    const metrics = parser.finish();
    expect(metrics).toMatchObject({
      input: 13,
      output: 5,
      totalTokens: 18,
      topLevelToolCalls: 2,
      codemodeCalls: 1,
      nestedCalls: 2,
      nestedCallsComplete: false,
      codemodeFailures: 1,
      finalText: "done",
      stopReason: "stop",
    });
    expect(metrics.cost).toBeCloseTo(0.12);
    expect(metrics.commands).toEqual(["npx vitest run test/extensions/todos.test.ts"]);
  });

  it("rejects diagnostics on stdout and truncated JSON", () => {
    expect(() => new JsonlMetrics().push("not JSON\n")).toThrow(/JSONL/);
    const parser = new JsonlMetrics();
    parser.push('{"type":');
    expect(() => parser.finish()).toThrow(/JSONL/);
  });

  it("accounts for compaction and standalone usage without counting nested events twice", () => {
    const parser = new JsonlMetrics();
    parser.push(line({ type: "compaction_end", result: { usage: { input: 3, output: 1 } } }));
    parser.push(
      line({ type: "entry_appended", entry: { type: "usage", usage: { input: 2, cacheRead: 4 } } }),
    );
    parser.push(line({ type: "tool_execution_end", result: { usage: { input: 100 } } }));
    expect(parser.finish()).toMatchObject({
      input: 5,
      output: 1,
      cacheRead: 4,
      totalTokens: 10,
      settled: false,
    });
  });

  it("aggregates medians and pass rates by model, arm, and task", () => {
    const runs = [1, 3, 9, 11].map((n) => ({
      model: "example/test",
      arm: "on",
      task: n === 11 ? "other" : "inventory",
      passed: n !== 9,
      wallMs: n * 10,
      metrics: {
        ...sampleMetrics(),
        totalTokens: n,
        cost: n / 100,
        topLevelToolCalls: n,
        nestedCalls: n + 1,
      },
    }));
    expect(aggregateRuns(runs)).toEqual([
      expect.objectContaining({
        model: "example/test",
        arm: "on",
        runs: 4,
        passed: 3,
        passRate: 0.75,
        medianTokens: 6,
        medianCost: 0.06,
        medianWallMs: 60,
        medianToolCalls: 6,
        medianNestedCalls: 7,
      }),
    ]);
    const perTask = aggregateRuns(runs, true);
    expect(perTask).toHaveLength(2);
    expect(perTask.find((row) => row.task === "inventory")).toMatchObject({
      runs: 3,
      passed: 2,
      medianTokens: 3,
    });
    expect(aggregateRuns([])).toEqual([]);
  });
});

const files = {
  "extensions/ask-user/ask-user.ts": "export default async function askUserExtension() {}",
  "extensions/code-search/code-search.ts":
    "export default async function codeSearchExtension() { ctx.ui.notify('one'); ctx.ui.notify('two'); }",
  "extensions/code-search/src/client.ts": 'import { isNodeError } from "../../../lib/errors.ts";',
  "extensions/web-search/web-search.ts":
    'import { isNodeError } from "../../lib/errors.ts"; ctx.ui.notify("x");',
  "test/other.test.ts": "ctx.ui.notify('not an extension');",
};
const oracle = deriveExpectations(files, 33);

function answer(value: unknown) {
  return `Zero Cool\nCODEMODE_RESULT=${JSON.stringify(value)}\n`;
}

describe("codemode evaluation task checkers", () => {
  it("derives reference import sets, file facts, and occurrence counts from pinned files", () => {
    expect(oracle.imports).toEqual(["code-search", "web-search"]);
    expect(oracle.facts).toEqual({
      "ask-user": "askUserExtension",
      "code-search": "codeSearchExtension",
    });
    expect(oracle.ui).toEqual({ "code-search": 2, "web-search": 1 });
    expect(oracle.counts["background-jobs"]).toBe(3);
    expect(oracle.counts["web-search"]).toBe(2);
    expect(oracle.inventory["web-search"]).toEqual(["web_fetch", "web_search"]);
    expect(Object.keys(oracle.inventory)).toHaveLength(14);
    expect(oracle.inventory["worker-sandbox"]).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("rejects incomplete or incorrect fixed reference tables before paid runs", () => {
    const sources = {
      "extensions/a/a.ts": "pi.registerTool({}); pi.registerTool({});",
      "extensions/b/b.ts": "pi.registerTool({});",
    };
    expect(() =>
      validateReferenceCounts(sources, {
        inventory: { a: ["a1", "a2"], b: ["b"] },
        counts: { a: 2, b: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      validateReferenceCounts(sources, { inventory: { a: ["a1", "a2"] }, counts: { a: 2 } }),
    ).toThrow(/reference/);
    expect(() =>
      validateReferenceCounts(sources, {
        inventory: { a: ["a1", "a2"], b: ["b"] },
        counts: { a: 1, b: 1 },
      }),
    ).toThrow(/reference/);
  });

  it("parses the final marker, not earlier prose or Unicode separators", () => {
    expect(parseAnswer('Zero Cool\u2028text\nCODEMODE_RESULT={"a":1}\n')).toEqual({ a: 1 });
    expect(parseAnswer('CODEMODE_RESULT={"old":1}\nCODEMODE_RESULT={"a":2}')).toEqual({ a: 2 });
    expect(() => parseAnswer("{}")).toThrow(/CODEMODE_RESULT/);
    expect(() => parseAnswer("CODEMODE_RESULT={bad}")).toThrow();
  });

  it.each(["inventory", "counts", "imports", "tests", "failure", "rename", "facts", "ui"] as const)(
    "accepts correct %s answers and rejects incorrect answers",
    (task) => {
      const evidence = {
        commands: ["npx vitest run test/extensions/todos.test.ts"],
        typecheckPassed: true,
        renameExact: true,
      };
      expect(checkAnswer(task, answer(oracle[task]), oracle, evidence)).toEqual({
        passed: true,
        reason: "matched",
      });
      expect(checkAnswer(task, answer({ wrong: true }), oracle, evidence).passed).toBe(false);
      expect(checkAnswer(task, "no marker", oracle, evidence).passed).toBe(false);
    },
  );

  it("accepts reordered sets but rejects duplicates and missing entries", () => {
    expect(checkAnswer("imports", answer(["web-search", "code-search"]), oracle).passed).toBe(true);
    expect(
      checkAnswer("imports", answer(["web-search", "code-search", "code-search"]), oracle).passed,
    ).toBe(false);
    expect(checkAnswer("imports", answer(["code-search"]), oracle).passed).toBe(false);
  });

  it("requires test execution evidence rather than a guessed pass count", () => {
    expect(checkAnswer("tests", answer({ passCount: 33 }), oracle).passed).toBe(false);
  });

  it("requires both a real typecheck and an exact rename for the edit task", () => {
    expect(
      checkAnswer("rename", answer({ renamed: true }), oracle, {
        typecheckPassed: false,
        renameExact: true,
      }).passed,
    ).toBe(false);
    expect(
      checkAnswer("rename", answer({ renamed: true }), oracle, {
        typecheckPassed: true,
        renameExact: false,
      }).passed,
    ).toBe(false);
  });

  it("provides eight noninteractive prompts with a fixed answer marker", () => {
    const prompts = taskPrompts();
    expect(Object.keys(prompts)).toEqual([
      "inventory",
      "counts",
      "imports",
      "tests",
      "failure",
      "rename",
      "facts",
      "ui",
    ]);
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toContain("CODEMODE_RESULT=");
      expect(prompt).toContain("Do not ask questions");
    }
    expect(prompts.rename).toContain("isNodeError");
  });
});
