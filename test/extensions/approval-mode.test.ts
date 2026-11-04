import type { ClassifierAnswer, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import approvalMode from "../../extensions/approval-mode/approval-mode.ts";
import { judgeCommand } from "../../extensions/approval-mode/src/jev.ts";
import { connectWorkerApprovalChannel } from "../../lib/worker-approval.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { fakeKeybindings, fakeTui, sessionEntries } from "../mocks/test-helpers.ts";

const workerChannel = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn() }));
vi.mock("../../lib/worker-approval.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/worker-approval.ts")>();
  return { ...actual, connectWorkerApprovalChannel: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PI_WORKER_APPROVAL_FD", "");
  vi.stubEnv("PI_WORKER", "0");
  vi.mocked(connectWorkerApprovalChannel).mockReturnValue(workerChannel);
});

/** Registry classify mock with a declared signature, so mock.calls is a proper tuple. */
type ClassifyFn = (
  model: unknown,
  context: ClassifierContext,
  options: unknown,
) => Promise<ClassifierResult>;
type ClassifyMock = Mock<ClassifyFn>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("approval-mode Jev diagnostics", () => {
  it("reports validated scores to the local evaluator without changing the decision", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.31, secrets: 0.05 });
    const result = await judgeCommand({
      command: "npm run check",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    expect(result).toMatchObject({
      decision: "uncertain",
      scores: { harm: 0.31, secrets: 0.05, externalChange: 0.01 },
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("classifies through the available registry classifier with bool questions", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 });
    for (let call = 0; call < 3; call++) {
      expect(
        (
          await judgeCommand({
            command: "npm run check",
            cwd: "/workspace",
            modelRegistry: registry,
          })
        ).decision,
      ).toBe("allow");
    }
    expect(classify).toHaveBeenCalledTimes(3);
    const [model, context, options] = classify.mock.calls[0];
    expect(model).toMatchObject({ provider: "typesafe", id: "jev-latest" });
    expect(context.state).toEqual({ command: "npm run check", cwd: "/workspace" });
    expect(Object.keys(context.questions).sort()).toEqual(["externalChange", "harm", "secrets"]);
    expect(context.questions.externalChange.type).toBe("bool");
    expect(options).toMatchObject({ timeoutMs: 4_000, maxRetries: 2 });
  });

  it("does not auto-approve commands with executable helper options", async () => {
    const { registry } = registryAnswering({ harm: 0.01, secrets: 0.01 });
    for (const command of [
      "git -c core.fsmonitor=./evil status --short",
      "git ls-remote --upload-pack=./evil .",
      "sort --compress-program=./evil input",
      "rg --pre ./evil pattern",
      "fd -xnode payload",
      "fd --exec node payload",
      "fd --exec-batch node payload",
      "find ./src -type f -exec node payload {} +",
      "find ./src -type f -execdir node payload {} +",
      "git -c core.pager=./evil log -1",
      "git -c gpg.program=./evil commit -S -m test",
    ]) {
      expect(
        (await judgeCommand({ command, cwd: "/workspace", modelRegistry: registry })).decision,
      ).toBe("uncertain");
    }
  });

  it("rejects persistent writes outside the project", async () => {
    const { registry } = registryAnswering({ harm: 0.01, secrets: 0.01, externalChange: 0.91 });
    expect(
      (
        await judgeCommand({
          command: "cp dist/bundle.js /var/www/html/",
          cwd: "/workspace",
          modelRegistry: registry,
        })
      ).decision,
    ).toBe("reject");
  });

  it("does not send task context or reload acknowledgments to the risk judge", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.01, secrets: 0.04 });
    await judgeCommand({
      command: "git diff -- src/auth.ts",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    const context = classify.mock.calls[0][1];
    expect(context.state).toEqual({ command: "git diff -- src/auth.ts", cwd: "/workspace" });
  });

  it("asks about concrete secret access rather than hypothetical output from normal project work", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.01, secrets: 0.03 });
    await judgeCommand({
      command: "git diff -- src/auth.ts",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    const context = classify.mock.calls[0][1];
    expect(context.questions.secrets.instructions).toMatch(
      /specific.*credential|credential.*specific/i,
    );
    const secrets = context.questions.secrets;
    if (secrets.type !== "bool") throw new Error("Expected a bool secret question");
    expect(secrets.criteria.false).toMatch(/incidental/i);
  });

  it("allows low concrete secret risk but escalates higher scores", async () => {
    const options = {
      command: "npx biome check --write src/auth.ts",
      cwd: "/workspace",
    };
    const lowRisk = registryAnswering({ harm: 0.04, secrets: 0.3 });
    expect((await judgeCommand({ ...options, modelRegistry: lowRisk.registry })).decision).toBe(
      "allow",
    );
    const escalated = registryAnswering({ harm: 0.04, secrets: 0.31 });
    expect((await judgeCommand({ ...options, modelRegistry: escalated.registry })).decision).toBe(
      "uncertain",
    );
  });

  it("allows residual harm and outside-change scores up to their limits", async () => {
    const options = { command: "node /tmp/probe.mjs", cwd: "/workspace" };
    for (const [probabilities, decision] of [
      [{ harm: 0.3, secrets: 0.01, externalChange: 0.4 }, "allow"],
      [{ harm: 0.31, secrets: 0.01, externalChange: 0.01 }, "uncertain"],
      [{ harm: 0.01, secrets: 0.01, externalChange: 0.41 }, "uncertain"],
    ] as const) {
      const { registry } = registryAnswering(probabilities);
      expect((await judgeCommand({ ...options, modelRegistry: registry })).decision).toBe(decision);
    }
  });

  it.each([
    ['printf "%s\\n" "[layout]" > ~/.config/herdr/layout.toml', 0.73],
    ["rm -rf ~/.config/herdr/sessions", 0.62],
    ["ansible-playbook bootstrap.yml -i hosts", 0.68],
  ] as const)(
    "keeps replay outside-write risk uncertain for %s",
    async (command, externalChange) => {
      const { registry } = registryAnswering({ harm: 0.01, secrets: 0.01, externalChange });
      expect(
        (await judgeCommand({ command, cwd: "/workspace", modelRegistry: registry })).decision,
      ).toBe("uncertain");
    },
  );

  it("tells the judge which routine work is not risk", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.01, secrets: 0.01 });
    await judgeCommand({
      command: "node /tmp/probe.mjs",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    const { questions } = classify.mock.calls[0][1];
    expect(questions.harm.instructions).toMatch(/local script.*source is not shown/i);
    expect(questions.harm.instructions).toMatch(/temporary.*not serious damage/i);
    expect(questions.secrets.instructions).toMatch(
      /environment variables that are not credentials/i,
    );
    expect(questions.externalChange.instructions).toMatch(/herdboard/);
    expect(questions.externalChange.instructions).toMatch(/herdr/);
  });

  it("rejects concrete secret disclosure and keeps borderline secret risk uncertain", async () => {
    const exposing = registryAnswering({ harm: 0.01, secrets: 0.85 });
    const options = {
      command: "cat ~/.ssh/id_ed25519",
      cwd: "/workspace",
    };
    expect((await judgeCommand({ ...options, modelRegistry: exposing.registry })).decision).toBe(
      "reject",
    );
    const borderline = registryAnswering({ harm: 0.01, secrets: 0.5 });
    expect((await judgeCommand({ ...options, modelRegistry: borderline.registry })).decision).toBe(
      "uncertain",
    );
  });
});

describe("approval-mode classifier resolution", () => {
  it("prefers hosted Jev classifiers in priority order", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 }, [
      jevModel("openrouter", "typesafe/jev-latest"),
      jevModel("typesafe", "jev-latest"),
    ]);
    await judgeCommand({ command: "npm test", cwd: "/workspace", modelRegistry: registry });
    expect(classify.mock.calls[0][0]).toMatchObject({ provider: "typesafe", id: "jev-latest" });
  });

  it("falls back to a Jev-named classifier on another provider", async () => {
    const { classify, registry } = registryAnswering(
      { harm: 0.03, secrets: 0.02 },
      undefined,
      jevModel("opencode", "jev-1.13"),
    );
    await judgeCommand({ command: "npm test", cwd: "/workspace", modelRegistry: registry });
    expect(classify.mock.calls[0][0]).toMatchObject({ provider: "opencode", id: "jev-1.13" });
  });

  it("uses a local classifier as a last resort", async () => {
    const { classify, registry } = registryAnswering(
      { harm: 0.03, secrets: 0.02 },
      undefined,
      jevModel("llama-cpp", "Qwen3-8B"),
    );
    const result = await judgeCommand({
      command: "npm test",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    expect(classify.mock.calls[0][0]).toMatchObject({ provider: "llama-cpp", id: "Qwen3-8B" });
    expect(result.decision).toBe("allow");
  });

  it("prefers hosted Jev over Luna and native llama.cpp decision models", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 }, [
      { ...jevModel("openai", "gpt-6-luna"), api: "openai-decisions" },
      jevModel("llama-cpp", "Julia-1"),
      jevModel("llama-cpp", "OpenJev"),
      jevModel("typesafe", "jev-latest"),
    ]);

    await judgeCommand({ command: "npm test", cwd: "/workspace", modelRegistry: registry });

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", id: "jev-latest" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("prefers native OpenJev over other classifiers when hosted Jev is unavailable", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 }, [
      { ...jevModel("openai", "gpt-6-luna"), api: "openai-decisions" },
      jevModel("llama-cpp", "Julia-1"),
      jevModel("llama-cpp", "OpenJev"),
    ]);

    const result = await judgeCommand({
      command: "npm test",
      cwd: "/workspace",
      modelRegistry: registry,
    });

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "llama-cpp", id: "OpenJev" }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.decision).toBe("allow");
  });

  it.each([
    ["openai", "gpt-6-luna", "openai-decisions"],
    ["llama-cpp", "Julia-1", "typesafe-system-one"],
    ["llama-cpp", "Laya", "typesafe-system-one"],
    ["llama-cpp", "Kev", "typesafe-system-one"],
    ["llama-cpp", "lev", "typesafe-system-one"],
  ])("uses %s/%s through the registry with validated bool answers", async (provider, id, api) => {
    const model = { ...jevModel(provider, id), api };
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 }, [model]);

    const result = await judgeCommand({
      command: "npm test",
      cwd: "/workspace",
      modelRegistry: registry,
    });

    expect(classify).toHaveBeenCalledWith(model, expect.anything(), expect.anything());
    expect(result).toMatchObject({
      decision: "allow",
      scores: { harm: 0.03, secrets: 0.02, externalChange: 0.01 },
    });
    const context = classify.mock.calls[0][1];
    expect(Object.values(context.questions).every((question) => question.type === "bool")).toBe(
      true,
    );
    expect(context.images).toBeUndefined();
  });

  it("does not change classifiers after a failed judgment", async () => {
    const { classify, registry } = registryAnswering(
      { harm: 0.03, secrets: 0.02 },
      [
        jevModel("typesafe", "jev-latest"),
        { ...jevModel("openai", "gpt-6-luna"), api: "openai-decisions" },
      ],
      undefined,
      { stopReason: "error", errorMessage: "Classifier unavailable" },
    );

    const result = await judgeCommand({
      command: "npm test",
      cwd: "/workspace",
      modelRegistry: registry,
    });

    expect(result.decision).toBe("unavailable");
    expect(result.reason).toContain("Classifier unavailable");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0]).toMatchObject({ provider: "typesafe", id: "jev-latest" });
  });

  it("fails closed when no classifier has working credentials", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 }, []);
    const result = await judgeCommand({
      command: "npm test",
      cwd: "/workspace",
      modelRegistry: registry,
    });
    expect(result.decision).toBe("unavailable");
    expect(classify).not.toHaveBeenCalled();
  });

  it("treats an errored or aborted classification as unavailable", async () => {
    const errored = registryAnswering({ harm: 0.03, secrets: 0.02 }, undefined, undefined, {
      stopReason: "error",
      errorMessage: "TypeSafe API error",
    });
    expect(
      (
        await judgeCommand({
          command: "npm test",
          cwd: "/workspace",
          modelRegistry: errored.registry,
        })
      ).decision,
    ).toBe("unavailable");
    const aborted = registryAnswering({ harm: 0.03, secrets: 0.02 }, undefined, undefined, {
      stopReason: "aborted",
    });
    expect(
      (
        await judgeCommand({
          command: "npm test",
          cwd: "/workspace",
          modelRegistry: aborted.registry,
        })
      ).decision,
    ).toBe("unavailable");
  });

  it("refuses oversized commands and commands with recognized credentials before classifying", async () => {
    const { classify, registry } = registryAnswering({ harm: 0.03, secrets: 0.02 });
    expect(
      (
        await judgeCommand({
          command: `echo ${"x".repeat(5_000)}`,
          cwd: "/workspace",
          modelRegistry: registry,
        })
      ).decision,
    ).toBe("unavailable");
    expect(
      (
        await judgeCommand({
          command: "ghp_abcdefghijklmnopqrstuvwxyz012345 --help",
          cwd: "/workspace",
          modelRegistry: registry,
        })
      ).decision,
    ).toBe("unavailable");
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("approval-mode extension", () => {
  it("shares live mode with workers and resets it at session start", async () => {
    const { pi, ctx } = await setup();
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: true });
    await command?.("off", ctx);
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: false });
    await command?.("on", ctx);
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: true });
    await command?.("off", ctx);
    const start = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    await start?.({ type: "session_start" }, ctx);
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: true });
  });

  it("shows worker identity and directory in the parent dialog and approves only once", async () => {
    const { pi, ctx } = await setup();
    ctx.mode = "rpc";
    ctx.ui.select.mockResolvedValueOnce("Approve once").mockResolvedValueOnce("Block");
    const request = workerRequest();
    expect(await parentRequest(pi, request)).toEqual({ approved: true });
    expect(await parentRequest(pi, request)).toEqual({ approved: false });
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    const title = ctx.ui.select.mock.calls[0]?.[0];
    expect(title).toContain("researcher");
    expect(title).toContain("w-test");
    expect(title).toContain("/workspace/worker");
    expect(title).toContain("npm test");
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.any(String),
      ["Block", "Approve once"],
      expect.any(Object),
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("serializes worker and main dialogs through one queue", async () => {
    const { pi, ctx, handler } = await setup({ probabilities: { harm: 0.5, secrets: 0.5 } });
    const started = deferred<void>();
    const choice = deferred<string>();
    ctx.ui.custom
      .mockImplementationOnce(() => {
        started.resolve();
        return choice.promise;
      })
      .mockResolvedValueOnce("Block");
    const workerResult = parentRequest(pi, workerRequest());
    await started.promise;
    const mainResult = handler({ toolName: "bash", input: { command: "npm test" } }, ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    choice.resolve("Approve once");
    expect(await workerResult).toEqual({ approved: true });
    expect(await mainResult).toMatchObject({ block: true });
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
  });

  it("cancels an active worker dialog when the parent turns review off", async () => {
    const { pi, ctx } = await setup();
    ctx.mode = "rpc";
    const started = deferred<void>();
    ctx.ui.select.mockImplementation(
      (_title, _choices, options) =>
        new Promise((resolve) => {
          started.resolve();
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );
    const result = parentRequest(pi, workerRequest());
    await started.promise;
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    await command?.("off", ctx);
    expect(await result).toEqual({ approved: true });
  });

  it("blocks an active worker dialog when its request is cancelled", async () => {
    const { pi, ctx } = await setup();
    ctx.mode = "rpc";
    const started = deferred<void>();
    ctx.ui.select.mockImplementation(
      (_title, _choices, options) =>
        new Promise((resolve) => {
          started.resolve();
          options?.signal?.addEventListener("abort", () => resolve("Approve once"), { once: true });
        }),
    );
    const controller = new AbortController();
    const result = parentRequest(pi, workerRequest(), controller.signal);
    await started.promise;
    controller.abort();
    expect(await result).toEqual({ approved: false });
  });

  it("keeps worker hard denies active when shared review is off", async () => {
    const { pi, ctx } = await setup();
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    await command?.("off", ctx);
    expect(await parentRequest(pi, workerRequest())).toEqual({ approved: true });
    expect(await parentRequest(pi, { ...workerRequest(), command: "rm -rf /" })).toEqual({
      approved: false,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("blocks a worker approval with a mismatched execution directory", async () => {
    const { pi, ctx } = await setup();
    expect(await parentRequest(pi, { ...workerRequest(), cwd: "/other-project" })).toEqual({
      approved: false,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("blocks worker approvals without a parent interface or after cancellation", async () => {
    const { pi, ctx } = await setup({}, false);
    expect(await parentRequest(pi, workerRequest())).toEqual({ approved: false });
    ctx.hasUI = true;
    const controller = new AbortController();
    controller.abort();
    expect(await parentRequest(pi, workerRequest(), controller.signal)).toEqual({
      approved: false,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("gates bash, background, and monitor with the same Jev decision", async () => {
    const classify = allowing();
    const { handler, ctx } = await setup({ classify });
    for (const toolName of ["bash", "background", "monitor"]) {
      expect(await handler({ toolName, input: { command: "npm test" } }, ctx)).toBeUndefined();
    }
    expect(classify).toHaveBeenCalledTimes(3);
    const context = classify.mock.calls[0][1];
    expect(context.state.command).toBe("npm test");
    expect(context.questions.externalChange.type).toBe("bool");
  });

  it("judges a background command in its requested directory", async () => {
    const classify = allowing();
    const { handler, ctx } = await setup({ classify });
    await handler(
      { toolName: "background", input: { command: "npm test", cwd: "/workspace/subdir" } },
      ctx,
    );
    expect(classify.mock.calls[0][1].state.cwd).toBe("/workspace/subdir");
  });

  it("uses the framed dialog in TUI mode and keeps native selection in RPC mode", async () => {
    const { handler, ctx } = await setup({ probabilities: { harm: 0.99, secrets: 0.01 } });
    ctx.ui.custom.mockResolvedValue("Block");
    ctx.ui.select.mockResolvedValue("Block");
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ overlay: true, onHandle: expect.any(Function) }),
    );
    expect(ctx.ui.select).not.toHaveBeenCalled();

    ctx.mode = "rpc";
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("npm test"),
      ["Block", "Approve once"],
      expect.any(Object),
    );
  });

  it("asks before a rejected main-chat command and grants only that call", async () => {
    const { handler, ctx } = await setup({ probabilities: { harm: 0.99, secrets: 0.01 } });
    ctx.mode = "rpc";
    ctx.ui.select.mockResolvedValueOnce("Approve once").mockResolvedValueOnce("Block");
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(ctx.ui.select.mock.calls[0]?.[0]).toContain("npm test");
  });

  it("asks for an uncertain judgment, and treats dismissal as block", async () => {
    const { handler, ctx } = await setup({ probabilities: { harm: 0.5, secrets: 0.5 } });
    ctx.mode = "rpc";
    ctx.ui.select.mockResolvedValue(undefined);
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("reviews extension command requests with the bash gate and shows their source", async () => {
    const { pi, ctx, classify } = await setup({ probabilities: { harm: 0.99, secrets: 0.01 } });
    ctx.mode = "rpc";
    ctx.ui.select.mockResolvedValueOnce("Approve once").mockResolvedValueOnce("Block");
    expect(await reviewRequest(pi, ctx, "npm test")).toEqual({ approved: true });
    expect(ctx.ui.select.mock.calls[0]?.[0]).toContain("Mission reconcile");
    const blocked = await reviewRequest(pi, ctx, "npm test");
    expect(blocked.approved).toBe(false);
    expect(blocked.reason).toContain("Approval Mode blocked");
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("refuses hard-deny extension commands without a dialog, even when review is off", async () => {
    const { pi, ctx, classify } = await setup();
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    await command?.("off", ctx);
    for (const denied of [
      "git reset --hard",
      "rm -rf $HOME/",
      "rm -rf ~/",
      "rm -rf //",
      "rm -rf */",
    ]) {
      const reply = await reviewRequest(pi, ctx, denied);
      expect(reply.approved).toBe(false);
      expect(reply.reason).toContain("hard deny");
    }
    expect(await reviewRequest(pi, ctx, "npm test")).toEqual({ approved: true });
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("approves known-safe and Jev-allowed extension commands without a dialog", async () => {
    const { pi, ctx } = await setup({ classify: allowing() });
    expect(await reviewRequest(pi, ctx, "git status")).toEqual({ approved: true });
    expect(await reviewRequest(pi, ctx, "npm test")).toEqual({ approved: true });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("refuses extension command requests in workers", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { pi, ctx, classify } = await setup({ classify: allowing() }, false);
    const reply = await reviewRequest(pi, ctx, "npm test");
    expect(reply.approved).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });

  it("never offers approval for hard denies, even when main gate is off", async () => {
    const { pi, handler, ctx } = await setup();
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    await command?.("off", ctx);
    expect(await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("approval-mode:state", { enabled: false });
  });

  it("warns at session startup when no classifier is available", async () => {
    vi.stubEnv("PI_WORKER", "0");
    const { ctx } = await setup({ classifiers: [] });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no Jev classifier is available"),
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("commands will be blocked"),
      "warning",
    );
  });

  it("does not warn at startup when a classifier is available", async () => {
    vi.stubEnv("PI_WORKER", "0");
    const { ctx } = await setup();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not show a startup warning in a headless worker", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const { ctx } = await setup({ classifiers: [] }, false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("runs plain herdboard commands without Jev or approval dialogs", async () => {
    const { handler, ctx, classify } = await setup({ classifiers: [] });
    for (const toolName of ["bash", "background", "monitor"]) {
      expect(
        await handler(
          {
            toolName,
            input: {
              command:
                'cd /workspace && ~/.local/share/uv/tools/herdboard/bin/python3 -I -m herdboard --json log t8kr "Tests pass."',
            },
          },
          ctx,
        ),
      ).toBeUndefined();
    }
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("reviews herdboard configuration, file, and module risks instead of bypassing Jev", async () => {
    const { handler, ctx, classify } = await setup({
      rejectFlag: "block",
      probabilities: { harm: 0.8, secrets: 0.01 },
    });
    const commands = [
      "herdboard list --source linear --config x.toml",
      "herdboard show t8kr -C/tmp",
      "herdboard attach t8kr ~/.pi/agent/auth.json",
      "herdboard add x --linear --body-file ~/.ssh/id_ed25519",
      "python3 -m herdboard show t8kr",
    ];
    for (const command of commands) {
      expect(await handler({ toolName: "bash", input: { command } }, ctx)).toEqual({
        block: true,
        reason: "Approval Mode blocked: The command presents serious damage risk.",
      });
    }
    expect(classify).toHaveBeenCalledTimes(commands.length);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("lets workers update routine Linear state without requesting parent approval", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const { handler, ctx, classify } = await setup({ classifiers: [] }, false);
    for (const command of [
      'herdboard add "Task" --linear --team ENG',
      'herdboard move ENG-123 "Review"',
    ]) {
      expect(await handler({ toolName: "bash", input: { command } }, ctx)).toBeUndefined();
    }
    expect(workerChannel.request).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("relays risky herdboard worker requests to the parent", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx } = await setup({ probabilities: { harm: 0.8, secrets: 0.01 } }, false);
    workerChannel.request
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ approved: false });
    const command = "herdboard list --source linear --config x.toml";
    expect(await handler({ toolName: "bash", input: { command } }, ctx)).toEqual({
      block: true,
      reason: "Approval Mode blocked: The command presents serious damage risk.",
    });
    expect(workerChannel.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "approval", command, decision: "reject" }),
      undefined,
    );
  });

  it("does not bypass Jev for herdboard commands with extra shell effects", async () => {
    const { handler, ctx, classify } = await setup({ probabilities: { harm: 0.5, secrets: 0.01 } });
    for (const command of [
      'herdboard --json log t8kr "$(touch /tmp/test)"',
      "herdboard show t8kr > /tmp/card",
      "herdboard show t8kr | sh",
    ]) {
      expect(await handler({ toolName: "bash", input: { command } }, ctx)).toEqual({
        block: true,
        reason: expect.stringContaining("Approval Mode blocked:"),
      });
    }
    expect(classify).toHaveBeenCalledTimes(3);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
  });

  it("allows exact Git status without Jev after a reload acknowledgment", async () => {
    const { handler, ctx } = await setup({ classifiers: [] });
    ctx.sessionManager.getBranch = vi.fn(() =>
      sessionEntries([{ type: "message", message: { role: "user", content: "I have reloaded." } }]),
    );
    expect(
      await handler({ toolName: "bash", input: { command: "git status --short" } }, ctx),
    ).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("blocks a command when no classifier is available, without offering an approval dialog", async () => {
    const { handler, ctx } = await setup({ classifiers: [] });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("blocks an errored or aborted classification without prompting", async () => {
    const classify: ClassifyMock = vi.fn(
      async (
        _model: unknown,
        _context: ClassifierContext,
        _options: unknown,
      ): Promise<ClassifierResult> => ({
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers: {},
        stopReason: "error",
        errorMessage: "TypeSafe API error",
        timestamp: Date.now(),
      }),
    );
    const { handler, ctx } = await setup({ classify });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("applies parent mode changes to an existing worker before each command", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx, classify } = await setup(
      { probabilities: { harm: 0.5, secrets: 0.5 } },
      false,
    );
    workerChannel.request
      .mockResolvedValueOnce({ enabled: false })
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValueOnce({ enabled: false });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(workerChannel.request).toHaveBeenNthCalledWith(1, { kind: "mode" }, undefined);
  });

  it("relays flagged worker commands and accepts only a matching approval reply", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx } = await setup({ probabilities: { harm: 0.5, secrets: 0.5 } }, false);
    workerChannel.request
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ approved: false });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(workerChannel.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "approval",
        command: "npm test",
        cwd: ctx.cwd,
        toolName: "bash",
        decision: "uncertain",
      }),
      undefined,
    );
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("blocks worker commands after parent disconnection and never relays classifier failures", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx } = await setup({ classifiers: [] }, false);
    workerChannel.request.mockResolvedValueOnce({ error: "Disconnected" });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    workerChannel.request.mockResolvedValueOnce({ enabled: true });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(workerChannel.request).toHaveBeenCalledTimes(2);
  });

  it("preserves read-only restrictions and hard denies when parent review is off", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_READONLY", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx } = await setup({}, false);
    workerChannel.request.mockResolvedValue({ enabled: false });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    for (const event of [
      { toolName: "edit", input: {} },
      { toolName: "background", input: { command: "npm test" } },
      { toolName: "bash", input: { command: "rm -rf /" } },
    ]) {
      expect(await handler(event, ctx)).toMatchObject({ block: true });
    }
    expect(workerChannel.request).toHaveBeenCalledTimes(1);
  });

  it("closes the worker channel and removes the parent listener on shutdown", async () => {
    const parent = await setup();
    const parentStop = parent.pi.on.mock.calls.find((call) => call[0] === "session_shutdown")?.[1];
    await parentStop?.({ type: "session_shutdown" }, parent.ctx);
    expect(parent.unsubscribe).toHaveBeenCalledTimes(2);
    expect(await parentRequest(parent.pi, workerRequest())).toEqual({ approved: false });
    const parentStart = parent.pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    await parentStart?.({ type: "session_start" }, parent.ctx);
    expect(parent.pi.events.on).toHaveBeenCalledTimes(4);
    expect(await parentRequest(parent.pi, { kind: "mode" })).toEqual({ enabled: true });
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const worker = await setup({}, false);
    const workerStop = worker.pi.on.mock.calls.find((call) => call[0] === "session_shutdown")?.[1];
    await workerStop?.({ type: "session_shutdown" }, worker.ctx);
    expect(workerChannel.close).toHaveBeenCalledTimes(1);
  });

  it("blocks rejected or uncertain worker commands without a UI", async () => {
    vi.stubEnv("PI_WORKER", "1");
    const { handler, ctx } = await setup({ probabilities: { harm: 0.5, secrets: 0.5 } });
    ctx.hasUI = false;
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("read-only workers block edits and unapproved commands, even when the main gate is off", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_READONLY", "1");
    const { handler, ctx } = await setup({ classifiers: [] });
    expect(await handler({ toolName: "edit", input: {} }, ctx)).toMatchObject({ block: true });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(await handler({ toolName: "bash", input: { command: "pwd" } }, ctx)).toBeUndefined();
  });
});

describe("approval-mode Herdr blocked events", () => {
  it("reports only the active TUI approval, not requests still queued", async () => {
    const { pi, ctx } = await setup();
    pi.events.emit.mockClear();
    const opened = deferred<void>();
    const firstChoice = deferred<string>();
    const secondOpened = deferred<void>();
    const secondChoice = deferred<string>();
    ctx.ui.custom
      .mockImplementationOnce(() => {
        opened.resolve();
        return firstChoice.promise;
      })
      .mockImplementationOnce(() => {
        secondOpened.resolve();
        return secondChoice.promise;
      });
    const first = parentRequest(pi, workerRequest());
    await opened.promise;
    const second = parentRequest(pi, workerRequest());
    expect(pi.events.emit).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: "Approval Mode",
    });
    firstChoice.resolve("Approve once");
    expect(await first).toEqual({ approved: true });
    await secondOpened.promise;
    expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
    expect(pi.events.emit).toHaveBeenNthCalledWith(3, "herdr:blocked", {
      active: true,
      label: "Approval Mode",
    });
    secondChoice.resolve("Block");
    expect(await second).toEqual({ approved: false });
    expect(pi.events.emit).toHaveBeenNthCalledWith(4, "herdr:blocked", { active: false });
    expect(pi.events.emit).toHaveBeenCalledTimes(4);
  });

  it("clears blocked state and releases the approval queue after a dialog error", async () => {
    const { pi, ctx } = await setup();
    pi.events.emit.mockClear();
    ctx.ui.custom.mockRejectedValueOnce(new Error("Dialog failed")).mockResolvedValueOnce("Block");
    expect(await parentRequest(pi, workerRequest())).toEqual({ approved: false });
    expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
    expect(await parentRequest(pi, workerRequest())).toEqual({ approved: false });
    expect(pi.events.emit).toHaveBeenNthCalledWith(3, "herdr:blocked", {
      active: true,
      label: "Approval Mode",
    });
    expect(pi.events.emit).toHaveBeenNthCalledWith(4, "herdr:blocked", { active: false });
    expect(pi.events.emit).toHaveBeenCalledTimes(4);
  });

  it("clears blocked state when an active approval is cancelled", async () => {
    const { pi, ctx } = await setup();
    pi.events.emit.mockClear();
    const opened = deferred<void>();
    ctx.ui.custom.mockImplementation(() => {
      opened.resolve();
      return new Promise((resolve) => {
        const factory = ctx.ui.custom.mock.calls.at(-1)?.[0];
        if (!factory) throw new Error("Missing dialog factory");
        factory(fakeTui(), ctx.ui.theme, fakeKeybindings(), resolve);
      });
    });
    const controller = new AbortController();
    const pending = parentRequest(pi, workerRequest(), controller.signal);
    await opened.promise;
    expect(pi.events.emit).toHaveBeenNthCalledWith(1, "herdr:blocked", {
      active: true,
      label: "Approval Mode",
    });
    controller.abort();
    expect(await pending).toEqual({ approved: false });
    expect(pi.events.emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false });
    expect(pi.events.emit).toHaveBeenCalledTimes(2);
  });

  it.each(["rpc", "no-ui", "pre-aborted", "hard-deny", "known-safe"])(
    "does not report blocked state for %s requests",
    async (scenario) => {
      const { pi, ctx, handler } = await setup();
      pi.events.emit.mockClear();
      if (scenario === "rpc") ctx.mode = "rpc";
      if (scenario === "no-ui") ctx.hasUI = false;
      if (scenario === "hard-deny" || scenario === "known-safe") {
        await handler(
          { toolName: "bash", input: { command: scenario === "hard-deny" ? "rm -rf /" : "pwd" } },
          ctx,
        );
      } else {
        const controller = new AbortController();
        if (scenario === "pre-aborted") controller.abort();
        await parentRequest(pi, workerRequest(), controller.signal);
      }
      expect(pi.events.emit).not.toHaveBeenCalledWith("herdr:blocked", expect.anything());
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    },
  );
});

describe("approval-mode --approval-mode flag", () => {
  it("starts a main session with review off when the flag is off", async () => {
    const { pi, handler, ctx, classify } = await setup({ flag: "off" });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("approval-mode", "Approval Mode off");
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: false });
  });

  it("keeps hard denies when the flag is off", async () => {
    const { handler, ctx } = await setup({ flag: "off" });
    expect(await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx)).toMatchObject({
      block: true,
    });
  });

  it("skips the classifier warning when the flag is off", async () => {
    const { ctx } = await setup({ classifiers: [], flag: "off" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps the classifier warning when the flag is on", async () => {
    const { ctx } = await setup({ classifiers: [], flag: "on" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no Jev classifier is available"),
      "warning",
    );
  });

  it.each(["maybe", ""])(
    "fails closed on invalid value %j and names the valid values",
    async (flag) => {
      const { handler, ctx } = await setup({ classifiers: [], flag });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(flag), "error");
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("--approval-mode"),
        "error",
      );
      expect(
        await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
      ).toMatchObject({
        block: true,
      });
    },
  );

  it("fails closed when the flag arrives without a value", async () => {
    const { handler, ctx } = await setup({ classifiers: [], flag: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--approval-mode"), "error");
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
  });

  it("reports invalid flags outside interactive mode", async () => {
    await expect(setup({ flag: "invalid" }, false)).rejects.toThrow(/--approval-mode.*on or off/);
  });

  it("re-reads the flag when the session restarts", async () => {
    const { pi, ctx } = await setup({ flag: "on" });
    pi.getFlag.mockImplementation((name: string) => (name === "approval-mode" ? "off" : undefined));
    const start = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    await start?.({ type: "session_start" }, ctx);
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: false });
  });

  it("lets the slash command turn review back on after an off start", async () => {
    const { pi, ctx, handler, classify } = await setup({ flag: "off" });
    const command = pi.registerCommand.mock.calls.find((call) => call[0] === "approval-mode")?.[1]
      .handler;
    await command?.("on", ctx);
    expect(await parentRequest(pi, { kind: "mode" })).toEqual({ enabled: true });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("keeps workers on the parent mode and ignores their own flag", async () => {
    vi.stubEnv("PI_WORKER", "1");
    vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
    const { handler, ctx, classify } = await setup({ classifiers: [], flag: "off" }, false);
    workerChannel.request.mockResolvedValueOnce({ enabled: true });
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toMatchObject({
      block: true,
    });
    expect(workerChannel.request).toHaveBeenCalledWith({ kind: "mode" }, undefined);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("approval-mode --approval-reject flag", () => {
  it("registers ask as the default reject policy", async () => {
    const { pi } = await setup();
    expect(pi.registerFlag).toHaveBeenCalledWith("approval-reject", {
      description: expect.any(String),
      type: "string",
      default: "ask",
    });
  });

  it.each([undefined, "ask"])("offers approval for rejects with %s", async (rejectFlag) => {
    const { ctx, handler } = await setup({
      ...(rejectFlag === undefined ? {} : { rejectFlag }),
      probabilities: { harm: 0.8, secrets: 0.01 },
    });
    ctx.ui.custom.mockResolvedValue("Approve once");
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it.each(["harm", "secrets", "externalChange"] as const)(
    "blocks a reject at the %s boundary without a dialog",
    async (score) => {
      const { pi, ctx, handler } = await setup({
        rejectFlag: "block",
        probabilities: { harm: 0.01, secrets: 0.01, externalChange: 0.01, [score]: 0.8 },
      });
      pi.events.emit.mockClear();
      for (const toolName of ["bash", "background", "monitor"]) {
        expect(await handler({ toolName, input: { command: "npm test" } }, ctx)).toEqual({
          block: true,
          reason: expect.stringMatching(/^Approval Mode blocked: .+\.$/),
        });
      }
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(pi.events.emit).not.toHaveBeenCalled();
    },
  );

  it("keeps low-risk commands allowed under the block policy", async () => {
    const { ctx, handler } = await setup({
      rejectFlag: "block",
      probabilities: { harm: 0.3, secrets: 0.3, externalChange: 0.4 },
    });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("still prompts for uncertainty below the reject boundary", async () => {
    const { ctx, handler } = await setup({
      rejectFlag: "block",
      probabilities: { harm: 0.79, secrets: 0.01 },
    });
    ctx.mode = "rpc";
    ctx.ui.select.mockResolvedValue("Approve once");
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("npm test"),
      ["Block", "Approve once"],
      expect.any(Object),
    );
  });

  it("applies the parent reject policy to workers while uncertainty still prompts", async () => {
    const { pi, ctx } = await setup({ rejectFlag: "block" });
    expect(await parentRequest(pi, { ...workerRequest(), decision: "reject" })).toEqual({
      approved: false,
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    ctx.ui.custom.mockResolvedValue("Approve once");
    expect(await parentRequest(pi, workerRequest())).toEqual({ approved: true });
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("blocks rejects without waiting for an uncertain request's dialog", async () => {
    const { pi, ctx } = await setup({ rejectFlag: "block" });
    const opened = deferred<void>();
    const choice = deferred<string>();
    ctx.ui.custom.mockImplementationOnce(() => {
      opened.resolve();
      return choice.promise;
    });
    const uncertain = parentRequest(pi, workerRequest());
    await opened.promise;
    const rejected = parentRequest(pi, { ...workerRequest(), decision: "reject" });
    try {
      expect(await rejected).toEqual({ approved: false });
    } finally {
      choice.resolve("Approve once");
    }
    expect(await uncertain).toEqual({ approved: true });
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it.each(["ask", "block", "invalid"])(
    "ignores worker reject flag %s and relays rejects to the parent",
    async (rejectFlag) => {
      vi.stubEnv("PI_WORKER", "1");
      vi.stubEnv("PI_WORKER_APPROVAL_FD", "3");
      const { ctx, handler } = await setup(
        { rejectFlag, probabilities: { harm: 0.8, secrets: 0.01 } },
        false,
      );
      workerChannel.request
        .mockResolvedValueOnce({ enabled: true })
        .mockResolvedValueOnce({ approved: true });
      expect(
        await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
      ).toBeUndefined();
      expect(workerChannel.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: "approval", decision: "reject" }),
        undefined,
      );
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it("applies reject blocking to extension command requests", async () => {
    const { pi, ctx } = await setup({
      rejectFlag: "block",
      probabilities: { harm: 0.8, secrets: 0.01 },
    });
    expect(await reviewRequest(pi, ctx, "npm test")).toEqual({
      approved: false,
      reason: "Approval Mode blocked: The command presents serious damage risk.",
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("skips reject blocking when review is off but keeps hard denies", async () => {
    const { pi, ctx, handler, classify } = await setup({ rejectFlag: "block", flag: "off" });
    expect(
      await handler({ toolName: "bash", input: { command: "npm test" } }, ctx),
    ).toBeUndefined();
    expect(await parentRequest(pi, { ...workerRequest(), decision: "reject" })).toEqual({
      approved: true,
    });
    expect(await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx)).toEqual({
      block: true,
      reason: expect.stringContaining("hard deny"),
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it.each(["invalid", "", true])("fails closed on invalid reject flag %j", async (rejectFlag) => {
    const { ctx, handler } = await setup({
      rejectFlag,
      probabilities: { harm: 0.8, secrets: 0.01 },
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/--approval-reject.*ask or block/),
      "error",
    );
    expect(await handler({ toolName: "bash", input: { command: "npm test" } }, ctx)).toEqual({
      block: true,
      reason: expect.stringContaining("Approval Mode blocked:"),
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    await expect(setup({ rejectFlag }, false)).rejects.toThrow(/--approval-reject.*ask or block/);
  });

  it("re-reads the reject policy when a session restarts", async () => {
    const { pi, ctx } = await setup({ rejectFlag: "block" });
    pi.getFlag.mockReturnValue(undefined);
    const start = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
    await start?.({ type: "session_start" }, ctx);
    ctx.ui.custom.mockResolvedValue("Approve once");
    expect(await parentRequest(pi, { ...workerRequest(), decision: "reject" })).toEqual({
      approved: true,
    });
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });
});

// --- Helpers ---

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workerRequest() {
  return {
    kind: "approval",
    command: "npm test",
    cwd: "/workspace/worker",
    toolName: "bash",
    decision: "uncertain",
    reason: "Risk is uncertain",
  };
}

function parentRequest(
  pi: ReturnType<typeof createMockPi>,
  request: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<unknown> {
  const handler = pi.events.on.mock.calls.find(
    (call) => call[0] === "approval-mode:worker-request",
  )?.[1];
  if (!handler) throw new Error("Worker approval listener missing");
  return new Promise((respond) => {
    handler({
      worker: { id: "w-test", name: "researcher", cwd: "/workspace/worker" },
      request,
      signal,
      respond,
    });
  });
}

function reviewRequest(
  pi: ReturnType<typeof createMockPi>,
  ctx: unknown,
  command: string,
): Promise<{ approved: boolean; reason?: string }> {
  const handler = pi.events.on.mock.calls.find(
    (call) => call[0] === "approval-mode:command-review",
  )?.[1];
  if (!handler) throw new Error("Command review listener missing");
  return new Promise((respond) => {
    let claimed = false;
    handler({
      ctx,
      command,
      cwd: "/workspace",
      source: "Mission reconcile: verification command",
      claim: () => {
        claimed = true;
      },
      respond,
    });
    if (!claimed) throw new Error("Command review was not claimed");
  });
}

function jevModel(provider: string, id: string) {
  return { provider, id, name: id, api: "typesafe-system-one" };
}

function allowing(probabilities?: {
  harm: number;
  secrets: number;
  externalChange?: number;
}): ClassifyMock {
  const { harm = 0.02, secrets = 0.01, externalChange = 0.01 } = probabilities ?? {};
  return vi.fn(
    async (
      _model: unknown,
      _context: ClassifierContext,
      _options: unknown,
    ): Promise<ClassifierResult> => ({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-latest",
      answers: {
        harm: { type: "bool", probability: harm },
        secrets: { type: "bool", probability: secrets },
        externalChange: { type: "bool", probability: externalChange },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }),
  );
}

/**
 * A registry mock with one available classifier. `available` overrides the
 * model list; `result` overrides the classification outcome.
 */
function registryAnswering(
  probabilities?: { harm: number; secrets: number; externalChange?: number },
  available?: ReturnType<typeof jevModel>[],
  overrideModel?: ReturnType<typeof jevModel>,
  result?: { stopReason: "stop" | "error" | "aborted"; errorMessage?: string },
) {
  const classify: ClassifyMock = vi.fn(
    async (
      _model: unknown,
      _context: ClassifierContext,
      _options: unknown,
    ): Promise<ClassifierResult> => {
      const answers: Record<string, ClassifierAnswer> = Object.fromEntries(
        Object.entries({ externalChange: 0.01, ...probabilities }).map(([id, probability]) => [
          id,
          { type: "bool", probability } satisfies ClassifierAnswer,
        ]),
      );
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers,
        ...(result ?? { stopReason: "stop" as const }),
        timestamp: Date.now(),
      };
    },
  );
  const models = available ?? [overrideModel ?? jevModel("typesafe", "jev-latest")];
  const registry = {
    getAvailableOfType: vi.fn(async () => models),
    classify,
  };
  return { classify, registry };
}

async function setup(
  options: {
    classifiers?: ReturnType<typeof jevModel>[];
    probabilities?: { harm: number; secrets: number; externalChange?: number };
    classify?: ClassifyMock;
    flag?: string | boolean;
    rejectFlag?: string | boolean;
  } = {},
  hasUI = true,
) {
  const pi = createMockPi();
  pi.getFlag.mockImplementation((name: string) => {
    if (name === "approval-mode") return options.flag;
    if (name === "approval-reject") return options.rejectFlag;
    return undefined;
  });
  const unsubscribe = vi.fn();
  pi.events.on.mockReturnValue(unsubscribe);
  const ctx = createMockCommandContext();
  ctx.hasUI = hasUI;
  ctx.sessionManager.getBranch = vi.fn(() =>
    sessionEntries([
      { type: "message", message: { role: "user", content: "Run tests for this project" } },
    ]),
  );
  const registry = ctx.modelRegistry as unknown as {
    getAvailableOfType: (type: "classifier") => Promise<unknown[]>;
    classify: ClassifyMock;
  };
  registry.getAvailableOfType = vi.fn(
    async () => options.classifiers ?? [jevModel("typesafe", "jev-latest")],
  );
  const classify = options.classify ?? allowing(options.probabilities);
  registry.classify = classify;
  await approvalMode(pi);
  const start = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
  await start?.({ type: "session_start" }, ctx);
  const handler = pi.on.mock.calls.find((call) => call[0] === "tool_call")?.[1];
  if (!handler) throw new Error("tool_call handler missing");
  return { pi, ctx, handler, classify, unsubscribe };
}
