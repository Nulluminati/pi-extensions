/** Offline pilot report. Never starts a model request or changes an attempt checkpoint. */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { EventLedger, normalizeUsage, sumUsage } from "./virtual-models-eval/ledger.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Offline report: node --import tsx scripts/report-virtual-models.mjs SOURCE... --output-dir PATH [--compatibility PATH]",
  );
  process.exit(0);
}
const sources = [];
let output;
let compatibilityPath;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--output-dir" || arg === "--compatibility") {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--output-dir") output = value;
    else compatibilityPath = value;
  } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
  else sources.push(resolve(arg));
}
if (!sources.length || !output) throw new Error("Supply source directories and --output-dir");
const optional = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const readJson = async (path) => {
  const text = await optional(path);
  return text === null ? null : JSON.parse(text);
};
const unknownUsage = () => normalizeUsage(undefined);
const usage = (value) => value ?? unknownUsage();
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const aggregate = (value) => value?.aggregate ?? null;
async function replay(path) {
  const text = await optional(path);
  if (text === null) return null;
  const ledger = new EventLedger();
  ledger.push(text);
  const result = ledger.finish();
  if (!result.settled || result.partialLine)
    result.usage = sumUsage([result.usage, unknownUsage()]);
  return result;
}
const compatibility = compatibilityPath ? await readJson(compatibilityPath) : null;
const manifests = [],
  attempts = [],
  batches = [];
for (const source of sources) {
  const invalidationRecord = await readJson(join(source, "invalidations.json"));
  const invalidations = invalidationRecord?.invalidatedAttempts ?? [];
  assert(
    !invalidations.length || invalidationRecord.approvedBy,
    "Invalidations require an approval record",
  );
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(source, entry.name);
    const manifest = await readJson(join(path, "manifest.json"));
    if (manifest?.phase !== "scored") continue;
    const directory = `${basename(source)}/${entry.name}`;
    manifests.push({ directory, ...manifest });
    const batch = await readJson(join(path, "batch.json"));
    if (batch) batches.push({ directory, ...batch });
    for (const name of (await readdir(join(path, "attempts"))).filter((name) =>
      name.endsWith(".json"),
    )) {
      const a = await readJson(join(path, "attempts", name));
      const c = a.case ?? manifest.cases.find((item) => item.id === a.caseId);
      assert(c && c.id === a.caseId, `Missing or inconsistent case: ${directory}/${name}`);
      const main = await replay(join(path, `${a.id}.events.jsonl`));
      const workers = [];
      let workerFiles = [];
      try {
        workerFiles = await readdir(join(path, `${a.id}.workers`));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const file of workerFiles.filter((file) => file.endsWith(".jsonl")))
        workers.push(await replay(join(path, `${a.id}.workers`, file)));
      const workerUsage = workers.length
        ? sumUsage(workers.map((worker) => worker.usage))
        : usage(a.workerUsage);
      const mainUsage = main ? main.usage : usage(a.main?.usage);
      const totalUsage = main
        ? sumUsage([mainUsage, workerUsage, usage(a.classifierUsage)])
        : usage(a.totalUsage);
      const invalidation = invalidations.find(
        (item) => item.directory === entry.name && item.id === a.id,
      );
      attempts.push({
        ...a,
        case: c,
        directory,
        runnerVersion: manifest.runnerVersion ?? "teop-runner-v1",
        originalRecordedUsage: a.totalUsage ?? null,
        main: main ?? a.main,
        workers: workers.length ? workers : (a.workers ?? []),
        workerUsage,
        totalUsage,
        invalidation: invalidation
          ? { ...invalidation, approvedBy: invalidationRecord.approvedBy }
          : null,
        rawEventsRetained:
          main !== null &&
          (!a.records?.length || workerFiles.some((file) => file.endsWith(".jsonl"))),
        knownTokenLowerBound:
          [...(main?.dispatches ?? []), ...workers.flatMap((worker) => worker.dispatches)].reduce(
            (sum, dispatch) => sum + (aggregate(dispatch.usage) ?? 0),
            0,
          ) + (aggregate(a.classifierUsage) ?? 0),
      });
    }
  }
}
const fingerprints = [...new Set(manifests.map((manifest) => manifest.fingerprint))];
if (fingerprints.length > 1) {
  assert(
    compatibility?.approvedBy &&
      fingerprints.every((value) => compatibility.allowedFingerprints?.includes(value)),
    "Mixed runner fingerprints require an explicit approved compatibility record",
  );
}
for (const key of ["policyVersion", "fixtureVersion", "taskCommit", "piVersion", "nodeVersion"])
  assert(new Set(manifests.map((manifest) => manifest[key])).size <= 1, `Incompatible ${key}`);
const completed = attempts.filter(
  (attempt) => attempt.status === "completed" && !attempt.invalidation,
);
assert.equal(
  new Set(completed.map((attempt) => attempt.caseId)).size,
  completed.length,
  "Do not select a favorable duplicate score",
);
const cases = completed.map((a) => {
  const worker = a.case.role === "worker";
  const focusUsage = worker
    ? sumUsage([usage(a.workerUsage), usage(a.classifierWorkerUsage)])
    : usage(a.totalUsage);
  const records = a.records ?? [];
  const workerMs =
    records.length &&
    records.every((record) => number(record.startedAt) !== null && number(record.endedAt) !== null)
      ? records.reduce((sum, record) => sum + record.endedAt - record.startedAt, 0)
      : worker
        ? null
        : 0;
  const dispatches = worker
    ? a.workers.flatMap((item) => item.dispatches ?? [])
    : (a.main?.dispatches ?? []);
  const chatCalls =
    (a.main?.calls ?? 0) + a.workers.reduce((sum, item) => sum + (item.calls ?? 0), 0);
  const raw = (a.routes ?? []).filter(
    (route) => route.type === "provider_usage" && number(route.usage?.total_tokens) !== null,
  );
  const chatUsage = sumUsage([usage(a.main?.usage), usage(a.workerUsage)]);
  const literalChatTotal =
    raw.length === chatCalls && aggregate(chatUsage) !== null
      ? raw.reduce((sum, route) => sum + route.usage.total_tokens, 0)
      : null;
  return {
    id: a.caseId,
    attempt: a.id,
    directory: a.directory,
    runnerVersion: a.runnerVersion,
    role: a.case.role,
    task: a.case.task,
    arm: a.case.arm,
    passed: a.passed,
    reason: a.reason,
    focusUsage,
    mainUsage: usage(a.main?.usage),
    workerUsage: usage(a.workerUsage),
    classifierUsage: usage(a.classifierUsage),
    classifierMainUsage: usage(a.classifierMainUsage),
    classifierWorkerUsage: usage(a.classifierWorkerUsage),
    routerClassifierUsage: usage(a.routerClassifierUsage),
    totalUsage: usage(a.totalUsage),
    wallMs: number(a.wallMs),
    workerMs,
    models: [...new Set(dispatches.map((dispatch) => `${dispatch.provider}/${dispatch.model}`))],
    thinking: [...new Set(dispatches.map((dispatch) => dispatch.thinkingLevel ?? "unknown"))],
    retries: (a.main?.retries ?? 0) + a.workers.reduce((sum, item) => sum + (item.retries ?? 0), 0),
    compactions:
      (a.main?.compactions ?? 0) +
      a.workers.reduce((sum, item) => sum + (item.compactions ?? 0), 0),
    switches: a.routerSwitches ?? 0,
    literalChatTotal,
    literalChatReports: raw.length,
    chatCalls,
    literalChatMatchesAggregate:
      literalChatTotal === null ? null : literalChatTotal === aggregate(chatUsage),
  };
});
assert(
  cases.every((item) => item.literalChatMatchesAggregate !== false),
  "Literal runtime usage does not match normalized chat usage",
);
const groups = [];
for (const role of ["main", "worker"])
  for (const arm of role === "main"
    ? ["sol", "deepseek", "glm", "rules", "jev"]
    : ["glm", "rules", "jev"]) {
    const rows = cases.filter((item) => item.role === role && item.arm === arm);
    const passed = rows.filter((item) => item.passed).length;
    const focusUsage = sumUsage(rows.map((item) => item.focusUsage));
    groups.push({
      role,
      arm,
      cases: rows.length,
      passed,
      focusUsage,
      totalUsage: sumUsage(rows.map((item) => item.totalUsage)),
      mainUsage: sumUsage(rows.map((item) => item.mainUsage)),
      workerUsage: sumUsage(rows.map((item) => item.workerUsage)),
      classifierUsage: sumUsage(rows.map((item) => item.classifierUsage)),
      routerClassifierUsage: sumUsage(rows.map((item) => item.routerClassifierUsage)),
      tokensPerSuccess:
        passed && aggregate(focusUsage) !== null ? aggregate(focusUsage) / passed : null,
      seconds: rows.every((item) => item.wallMs !== null)
        ? rows.reduce((sum, item) => sum + item.wallMs, 0) / 1000
        : null,
    });
  }
const pairs = [];
for (const role of ["main", "worker"])
  for (const router of ["rules", "jev"])
    for (const baseline of role === "main" ? ["sol", "deepseek", "glm"] : ["glm"])
      for (const task of ["boundaries", "diagnosis", "fix", "rename", "review", "schedule"]) {
        const r = cases.find(
            (item) => item.role === role && item.arm === router && item.task === task,
          ),
          b = cases.find(
            (item) => item.role === role && item.arm === baseline && item.task === task,
          );
        const rt = aggregate(r?.focusUsage),
          bt = aggregate(b?.focusUsage);
        pairs.push({
          role,
          router,
          baseline,
          task,
          available: !!r && !!b,
          successDifference: r && b ? Number(r.passed) - Number(b.passed) : null,
          tokenDifference: rt !== null && bt !== null ? rt - bt : null,
          tokenPercent: rt !== null && bt ? (100 * (rt - bt)) / bt : null,
          secondsDifference:
            r?.wallMs !== null && b?.wallMs !== null && r && b
              ? (r.wallMs - b.wallMs) / 1000
              : null,
        });
      }
const expense = (a) => ({
  id: a.id,
  caseId: a.caseId,
  directory: a.directory,
  reason: a.invalidation?.reason ?? a.reason,
  originalRecordedUsage: a.originalRecordedUsage,
  correctedTotalUsage: a.totalUsage,
  knownTokenLowerBound: a.knownTokenLowerBound,
  mainErrors: a.main?.errors ?? [],
  originalPassed: a.passed,
  invalidation: a.invalidation,
  rawEventsRetained: a.rawEventsRetained,
});
// Historical coverage is independent of the currently available router launch options.
const planned = groups.flatMap(({ role, arm }) =>
  ["boundaries", "diagnosis", "fix", "rename", "review", "schedule"].map((task) => ({
    id: `${role}-${task}-${arm}-r1`,
  })),
);
const report = {
  capturedAt: new Date().toISOString(),
  sources,
  fingerprints,
  compatibility,
  planned: planned.length,
  completed: cases.length,
  passed: cases.filter((item) => item.passed).length,
  pending: planned.filter((item) => !cases.some((a) => a.id === item.id)).map((item) => item.id),
  groups,
  cases,
  pairs,
  interrupted: attempts.filter((a) => a.status === "interrupted").map(expense),
  invalidated: attempts.filter((a) => a.invalidation).map(expense),
  manifests: manifests.map((m) => ({
    directory: m.directory,
    phase: m.phase,
    toolCommit: m.toolCommit,
    taskCommit: m.taskCommit,
    runnerVersion: m.runnerVersion ?? "teop-runner-v1",
    fingerprint: m.fingerprint,
    configurations: m.configurations,
  })),
  batches,
};
const fmt = (value) =>
  value === null || value === undefined
    ? "unknown"
    : typeof value === "number"
      ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : String(value);
const lines = [
  "# Pilot results",
  "",
  `Completed ${report.completed}/${report.planned}; passed ${report.passed}.`,
  `Invalidated attempts: ${report.invalidated.length}; interrupted attempts: ${report.interrupted.length}.`,
  "",
  "| Role | Arm | Pass | Focus tokens | All tokens | Classifier tokens | Tokens/success | Process seconds |",
  "|---|---|---|---|---|---|---|---|",
];
for (const g of groups)
  lines.push(
    `| ${g.role} | ${g.arm} | ${g.passed}/${g.cases} | ${fmt(g.focusUsage.aggregate)} | ${fmt(g.totalUsage.aggregate)} | ${fmt(g.classifierUsage.aggregate)} | ${fmt(g.tokensPerSuccess)} | ${fmt(g.seconds)} |`,
  );
lines.push(
  "",
  "| Role | Task | Arm | Pass | Physical models | Thinking | Focus tokens | Input | Output | Cache read | Cache write | Main | Worker | Classifier | All | Process s | Worker record s |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const c of [...cases].sort(
  (a, b) =>
    a.role.localeCompare(b.role) || a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm),
))
  lines.push(
    `| ${c.role} | ${c.task} | ${c.arm} | ${c.passed ? "pass" : "fail"} | ${c.models.join(", ")} | ${c.thinking.join(", ")} | ${fmt(c.focusUsage.aggregate)} | ${fmt(c.focusUsage.input)} | ${fmt(c.focusUsage.output)} | ${fmt(c.focusUsage.cacheRead)} | ${fmt(c.focusUsage.cacheWrite)} | ${fmt(c.mainUsage.aggregate)} | ${fmt(c.workerUsage.aggregate)} | ${fmt(c.classifierUsage.aggregate)} | ${fmt(c.totalUsage.aggregate)} | ${fmt(c.wallMs === null ? null : c.wallMs / 1000)} | ${fmt(c.workerMs === null ? null : c.workerMs / 1000)} |`,
  );
lines.push(
  "",
  "| Role | Router | Baseline | Task | Success delta | Token delta | Token % | Process seconds delta |",
  "|---|---|---|---|---|---|---|---|",
);
for (const p of pairs)
  lines.push(
    `| ${p.role} | ${p.router} | ${p.baseline} | ${p.task} | ${p.available ? fmt(p.successDifference) : "pending"} | ${p.available ? fmt(p.tokenDifference) : "pending"} | ${p.available ? fmt(p.tokenPercent) : "pending"} | ${p.available ? fmt(p.secondsDifference) : "pending"} |`,
  );
await mkdir(resolve(output), { recursive: true, mode: 0o700 });
await writeFile(join(output, "analysis.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
await writeFile(join(output, "tables.md"), `${lines.join("\n")}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      completed: report.completed,
      planned: report.planned,
      passed: report.passed,
      invalidated: report.invalidated.length,
      interrupted: report.interrupted.length,
      literalMismatches: cases
        .filter((item) => item.literalChatMatchesAggregate === false)
        .map((item) => item.id),
      configurationChanged: batches
        .filter((item) => !item.originalConfigurationUnchanged)
        .map((item) => item.directory),
    },
    null,
    2,
  ),
);
