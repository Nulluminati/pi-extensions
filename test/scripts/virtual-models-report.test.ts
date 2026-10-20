import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const script = resolve("scripts/report-virtual-models.mjs");
const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop() ?? "", { recursive: true, force: true });
});
const normalized = (tokens: number) => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  aggregate: tokens,
  providerTotal: tokens,
});
const frame = (tokens: number, stopReason = "stop") =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "test",
      model: "physical",
      stopReason,
      usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
      content: [],
    },
  }) +
  "\n" +
  JSON.stringify({ type: "agent_settled", aborted: false }) +
  "\n";
async function root() {
  const path = await mkdtemp(join(tmpdir(), "pi-virtual-report-test-"));
  cleanups.push(path);
  return path;
}
async function fixture(
  source: string,
  options: {
    fingerprint?: string;
    task?: string;
    role?: string;
    passed?: boolean;
    status?: string;
    tokens?: number;
    workerTokens?: number;
  } = {},
) {
  const {
    fingerprint = "fp-a",
    task = "diagnosis",
    role = "main",
    passed = false,
    status = "completed",
    tokens = 10,
    workerTokens = 0,
  } = options;
  const batch = join(source, "batch");
  await mkdir(join(batch, "attempts"), { recursive: true });
  const caseId = `${role}-${task}-glm-r1`,
    id = `${caseId}-a1`;
  const item = { id: caseId, role, task, arm: "glm" };
  await writeFile(
    join(batch, "manifest.json"),
    JSON.stringify({
      fingerprint,
      phase: "scored",
      toolCommit: fingerprint,
      taskCommit: "cc",
      policyVersion: "p1",
      fixtureVersion: "f1",
      piVersion: "1.3.0",
      nodeVersion: process.version,
      cases: [item],
    }),
  );
  await writeFile(
    join(batch, `${id}.events.jsonl`),
    frame(tokens, status === "interrupted" ? "error" : "stop"),
  );
  const classifierMain = role === "worker" ? 2 : 0,
    classifierWorker = role === "worker" ? 3 : 0;
  const a = {
    id,
    caseId,
    case: item,
    status,
    passed,
    reason: passed ? "passed" : "missing required result line",
    workerUsage: normalized(workerTokens),
    classifierUsage: normalized(classifierMain + classifierWorker),
    classifierMainUsage: normalized(classifierMain),
    classifierWorkerUsage: normalized(classifierWorker),
    routerClassifierUsage: normalized(0),
    totalUsage: normalized(tokens + workerTokens + classifierMain + classifierWorker),
    records: [],
    wallMs: 500,
    routes: [{ type: "provider_usage", usage: { total_tokens: tokens } }],
  };
  if (workerTokens) {
    await mkdir(join(batch, `${id}.workers`));
    await writeFile(join(batch, `${id}.workers/worker.jsonl`), frame(workerTokens));
    a.routes.push({ type: "provider_usage", usage: { total_tokens: workerTokens } });
  }
  await writeFile(join(batch, "attempts", `${id}.json`), JSON.stringify(a));
  return { id, caseId };
}
async function report(source: string, output: string, extras: string[] = []) {
  await execute(process.execPath, [
    "--import",
    "tsx",
    script,
    source,
    "--output-dir",
    output,
    ...extras,
  ]);
  return JSON.parse(await readFile(join(output, "analysis.json"), "utf8"));
}

describe("offline versioned pilot report", () => {
  it("retains completed failures and records invalidated positive results without selecting them", async () => {
    const path = await root(),
      source = join(path, "source");
    const { id, caseId } = await fixture(source, { passed: true });
    await writeFile(
      join(source, "invalidations.json"),
      JSON.stringify({
        approvedBy: "Zero Cool",
        invalidatedAttempts: [{ directory: "batch", id, reason: "test runner never loaded" }],
      }),
    );
    const result = await report(source, join(path, "out"));
    expect(result.completed).toBe(0);
    expect(result.invalidated).toHaveLength(1);
    expect(result.invalidated[0].correctedTotalUsage.aggregate).toBe(10);
    expect(result.pending).toContain(caseId);
    const failedSource = join(path, "failed-source");
    await fixture(failedSource);
    const retained = await report(source, join(path, "out"), [failedSource]);
    expect(retained.completed).toBe(1);
    expect(retained.passed).toBe(0);
    expect(retained.cases[0].reason).toBe("missing required result line");
  });
  it("rejects an invalidation without an approval record", async () => {
    const path = await root(),
      source = join(path, "source");
    const { id } = await fixture(source);
    await writeFile(
      join(source, "invalidations.json"),
      JSON.stringify({ invalidatedAttempts: [{ directory: "batch", id, reason: "unapproved" }] }),
    );
    await expect(report(source, join(path, "out"))).rejects.toThrow(
      "Invalidations require an approval record",
    );
  });

  it("separates worker focus costs from the fixed parent and retains classifier overhead", async () => {
    const path = await root(),
      source = join(path, "source");
    await fixture(source, {
      role: "worker",
      task: "review",
      passed: true,
      tokens: 100,
      workerTokens: 7,
    });
    const result = await report(source, join(path, "out"));
    expect(result.cases[0].focusUsage.aggregate).toBe(10);
    expect(result.cases[0].totalUsage.aggregate).toBe(112);
    expect(result.cases[0].classifierUsage.aggregate).toBe(5);
    expect(result.cases[0].literalChatMatchesAggregate).toBe(true);
  });
  it("replays SDK error placeholders as unknown while retaining the original checkpoint", async () => {
    const path = await root(),
      source = join(path, "source");
    await fixture(source, { status: "interrupted", tokens: 0 });
    const result = await report(source, join(path, "out"));
    expect(result.interrupted[0].originalRecordedUsage.aggregate).toBe(0);
    expect(result.interrupted[0].correctedTotalUsage.aggregate).toBeNull();
  });
  it("rejects totals that do not match literal runtime usage reports", async () => {
    const path = await root(),
      source = join(path, "source");
    const { id } = await fixture(source);
    const file = join(source, "batch", "attempts", `${id}.json`);
    const attempt = JSON.parse(await readFile(file, "utf8"));
    attempt.routes[0].usage.total_tokens = 999;
    await writeFile(file, JSON.stringify(attempt));
    await expect(report(source, join(path, "out"))).rejects.toThrow(
      "Literal runtime usage does not match normalized chat usage",
    );
  });

  it("refuses a favorable duplicate of a completed failure", async () => {
    const path = await root(),
      source = join(path, "source");
    const { id } = await fixture(source);
    await cp(join(source, "batch"), join(source, "second"), { recursive: true });
    const file = join(source, "second", "attempts", `${id}.json`);
    const attempt = JSON.parse(await readFile(file, "utf8"));
    attempt.passed = true;
    await writeFile(file, JSON.stringify(attempt));
    await expect(report(source, join(path, "out"))).rejects.toThrow(
      "Do not select a favorable duplicate score",
    );
  });

  it("requires explicit compatibility before combining runner fingerprints", async () => {
    const path = await root(),
      a = join(path, "a"),
      b = join(path, "b");
    await fixture(a);
    await fixture(b, { fingerprint: "fp-b", task: "review" });
    await expect(report(a, join(path, "out"), [b])).rejects.toThrow("Mixed runner fingerprints");
    const compatibility = join(path, "compatibility.json");
    await writeFile(
      compatibility,
      JSON.stringify({ approvedBy: "Zero Cool", allowedFingerprints: ["fp-a", "fp-b"] }),
    );
    expect(
      (await report(a, join(path, "out"), [b, "--compatibility", compatibility])).completed,
    ).toBe(2);
    await expect(report(a, join(path, "out"), ["--compatibility"])).rejects.toThrow(
      "requires a value",
    );
  });
});
