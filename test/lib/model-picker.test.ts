import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  createModelConfigFlow,
  formatModelDescription,
  formatTokenCount,
  type ModelConfigFlowOptions,
  type ModelConfigValue,
  selectModelWithSearch,
} from "../../lib/model-picker.ts";
import { fakeTui } from "../mocks/test-helpers.ts";

const ITEMS: SelectItem[] = [
  {
    value: "anthropic/claude-haiku-4-5",
    label: "anthropic/claude-haiku-4-5",
    description: "200k ctx · 64k out",
  },
  {
    value: "opencode-go/glm-5.3-flash",
    label: "opencode-go/glm-5.3-flash",
    description: "128k ctx",
  },
];

describe("model-picker formatting", () => {
  it("abbreviates token counts", () => {
    expect(formatTokenCount(0)).toBe("0k");
    // Values under 1k still scale into k ("999" rounds to 1k).
    expect(formatTokenCount(999)).toBe("1k");
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(1_500)).toBe("1.5k");
    expect(formatTokenCount(1_234_567)).toBe("1.2m");
    expect(formatTokenCount(2_000_000)).toBe("2m");
  });

  it("formats descriptions with name, sizes, and capability flags", () => {
    expect(
      formatModelDescription({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
      }),
    ).toBe("Claude Haiku 4.5 · 200k ctx · 64k out · image · reasoning");
  });

  it("omits the name when it equals the id", () => {
    expect(
      formatModelDescription({
        id: "glm-5.3-flash",
        name: "glm-5.3-flash",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_000,
      }),
    ).toBe("128k ctx · 8k out");
  });
});

describe("selectModelWithSearch", () => {
  /** Mocks ctx.ui.custom so the modal factory runs synchronously with stub
   *  tui/theme/keybindings and the created component is capturable, mirroring
   *  the picker tests for the small-model and worker-model extensions. */
  function pickerContext() {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    const custom = vi.fn(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (factory: any) =>
        new Promise<string | undefined>((resolve) => {
          component = factory(
            fakeTui(),
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: matchesPickerKey },
            resolve,
          );
        }),
    );
    const ctx = { ui: { custom } } as unknown as ExtensionCommandContext;
    return {
      ctx,
      component: () => {
        if (!component) throw new Error("picker modal was never created");
        return component;
      },
    };
  }

  it("renders the modal frame with the given title", async () => {
    const { ctx, component } = pickerContext();
    const pending = selectModelWithSearch(ctx, ITEMS, undefined, "Worker Model");

    const rendered = component().render(100).join("\n");
    expect(rendered).toContain("╭── Worker Model ");
    expect(rendered).toContain("anthropic/claude-haiku-4-5");

    component().handleInput("\u001b");
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves the highlighted item's value on confirm", async () => {
    const { ctx, component } = pickerContext();
    const pending = selectModelWithSearch(ctx, ITEMS, "opencode-go/glm-5.3-flash", "Small Model");

    component().handleInput("\r");

    await expect(pending).resolves.toBe("anthropic/claude-haiku-4-5");
  });

  it("resolves undefined when cancelled", async () => {
    const { ctx, component } = pickerContext();
    const pending = selectModelWithSearch(ctx, ITEMS, undefined, "Small Model");

    component().handleInput("\u001b");

    await expect(pending).resolves.toBeUndefined();
  });

  it("reports pi as blocked while the picker waits", async () => {
    const { ctx, component } = pickerContext();
    const pending = selectModelWithSearch(ctx, ITEMS, undefined, "Small Model");

    expect(vi.mocked(ctx.ui.custom).mock.calls[0]?.[1]).toEqual({
      blocked: { kind: "question", message: "Small Model" },
    });

    component().handleInput("\u001b");
    await pending;
  });
});

describe("createModelConfigFlow", () => {
  const REGISTRY_MODELS = [
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
    {
      id: "image-only",
      name: "Image Only",
      provider: "anthropic",
      reasoning: false,
      input: ["image"],
      contextWindow: 100_000,
      maxTokens: 8_000,
    },
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      provider: "opencode-go",
      reasoning: true,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_000,
    },
  ];

  interface StoredConfig {
    provider: string;
    model: string;
    thinkingLevel: ThinkingLevel;
  }

  /** Options with the common shape: load throws until overridden, saves are
   *  recorded, and validate/onApplied are inert spies until configured. */
  function flowFixture(overrides: Partial<ModelConfigFlowOptions> = {}) {
    const saved: StoredConfig[] = [];
    const validate = vi.fn(async (_config: ModelConfigValue, _ctx: ExtensionCommandContext) => {});
    const onApplied = vi.fn(async (_ctx: ExtensionCommandContext) => {});
    const options: ModelConfigFlowOptions = {
      label: "test",
      pickerTitle: "Test Model",
      selectTitle: "Select Global Test Model",
      loadConfig: () => {
        throw new Error("not configured");
      },
      defaultThinkingLevel: "low",
      saveConfig: (config) => {
        saved.push(config);
      },
      ...overrides,
    };
    return { options, saved, validate, onApplied };
  }

  /** Context whose ui.custom captures the modal component so tests drive
   *  input, mirroring the extension picker tests. */
  function flowContext(
    overrides: { mode?: "tui" | "rpc" | "json" | "print"; models?: typeof REGISTRY_MODELS } = {},
  ) {
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    const select = vi.fn(async (_title: string, values: string[]) => values[0]);
    const custom = vi.fn(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (factory: any) =>
        new Promise<string | undefined>((resolve) => {
          component = factory(
            fakeTui(),
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            { matches: matchesPickerKey },
            resolve,
          );
        }),
    );
    const notify = vi.fn();
    const ctx = {
      mode: overrides.mode ?? "tui",
      ui: { notify, select, custom },
      modelRegistry: { getAvailable: vi.fn(() => overrides.models ?? REGISTRY_MODELS) },
    } as unknown as ExtensionCommandContext;
    return {
      ctx,
      notify,
      select,
      custom,
      modal: () => {
        if (!component) throw new Error("picker modal was never created");
        return component;
      },
    };
  }

  it("selectModel sorts and filters the registry in the TUI modal and returns the choice", async () => {
    const stored: StoredConfig = {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      thinkingLevel: "xhigh",
    };
    const { options } = flowFixture({ loadConfig: () => ({ config: stored }) });
    const flow = createModelConfigFlow(options);
    const { ctx, modal, select } = flowContext();

    const pending = flow.selectModel(ctx);
    const rendered = modal().render(100).join("\n");

    expect(rendered).toContain("╭── Test Model ");
    expect(rendered).toContain("anthropic/claude-haiku-4-5");
    expect(rendered).toContain("Claude Haiku 4.5 · 200k ctx · 64k out · image · reasoning");
    expect(rendered).toContain("opencode-go/glm-5.3-flash");
    // Non-text models never reach the modal.
    expect(rendered).not.toContain("image-only");
    // Sorted by provider/id: anthropic entries before opencode-go.
    expect(rendered.indexOf("anthropic/claude-haiku-4-5")).toBeLessThan(
      rendered.indexOf("opencode-go/glm-5.3-flash"),
    );

    modal().handleInput("\r");
    await expect(pending).resolves.toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      thinkingLevel: "xhigh",
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("selectModel falls back to the default thinking level when unconfigured", async () => {
    const { options } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, modal } = flowContext();

    const pending = flow.selectModel(ctx);
    modal().handleInput("\r");

    await expect(pending).resolves.toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      thinkingLevel: "low",
    });
  });

  it("selectModel resolves undefined without saving when the modal is cancelled", async () => {
    const { options } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, modal } = flowContext();

    const pending = flow.selectModel(ctx);
    modal().handleInput("\u001b");

    await expect(pending).resolves.toBeUndefined();
  });

  it("selectModel uses the standard select outside TUI mode", async () => {
    const { options } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, custom, select } = flowContext({ mode: "rpc" });

    await expect(flow.selectModel(ctx)).resolves.toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      thinkingLevel: "low",
    });

    expect(select).toHaveBeenCalledWith("Select Global Test Model", [
      "anthropic/claude-haiku-4-5",
      "opencode-go/glm-5.3-flash",
    ]);
    expect(custom).not.toHaveBeenCalled();
  });

  it("selectModel reports an error when no authenticated text models exist", async () => {
    const { options } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, notify, custom, select } = flowContext({ models: [] });

    await expect(flow.selectModel(ctx)).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith("No authenticated text models are available.", "error");
    expect(custom).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("applyConfig validates, saves, runs onApplied, and confirms with the label", async () => {
    const { options, saved, validate, onApplied } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, notify } = flowContext();
    const order: string[] = [];
    validate.mockImplementation(async () => {
      order.push("validate");
    });
    onApplied.mockImplementation(async () => {
      order.push("onApplied");
    });
    options.validate = validate;
    options.onApplied = onApplied;

    const applied = await flow.applyConfig(
      { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
      ctx,
    );

    expect(applied).toBe(true);
    expect(order).toEqual(["validate", "onApplied"]);
    expect(saved).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
    ]);
    expect(notify).toHaveBeenCalledWith(
      "Global test model set to anthropic/claude-haiku-4-5 (high).",
      "info",
    );
  });

  it("applyConfig reports validation failures and saves nothing", async () => {
    const { options, saved, onApplied } = flowFixture();
    options.validate = () => {
      throw new Error("No credentials for test model");
    };
    const flow = createModelConfigFlow(options);
    const { ctx, notify } = flowContext();

    const applied = await flow.applyConfig(
      { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
      ctx,
    );

    expect(applied).toBe(false);
    expect(saved).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("No credentials for test model", "error");
  });

  it("applyConfig reports save failures with the label and skips onApplied", async () => {
    const { options, onApplied } = flowFixture();
    options.saveConfig = () => {
      throw new Error("EACCES");
    };
    const flow = createModelConfigFlow(options);
    const { ctx, notify } = flowContext();

    const applied = await flow.applyConfig(
      { provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "high" },
      ctx,
    );

    expect(applied).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Could not save global test model config: EACCES", "error");
  });

  it("applyThinkingLevel merges the level into the stored config", async () => {
    const stored: StoredConfig = {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      thinkingLevel: "low",
    };
    const { options, saved } = flowFixture({ loadConfig: () => ({ config: stored }) });
    const flow = createModelConfigFlow(options);
    const { ctx } = flowContext();

    const applied = await flow.applyThinkingLevel("xhigh", ctx);

    expect(applied).toBe(true);
    expect(saved).toEqual([
      { provider: "opencode-go", model: "glm-5.3-flash", thinkingLevel: "xhigh" },
    ]);
  });

  it("applyThinkingLevel reports load failures without saving", async () => {
    const { options, saved } = flowFixture();
    const flow = createModelConfigFlow(options);
    const { ctx, notify } = flowContext();

    const applied = await flow.applyThinkingLevel("xhigh", ctx);

    expect(applied).toBe(false);
    expect(saved).toEqual([]);
    expect(notify).toHaveBeenCalledWith("not configured", "error");
  });

  it("currentThinkingLevel reads the stored level and falls back to the default", () => {
    const stored: StoredConfig = {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      thinkingLevel: "max",
    };
    const loaded = flowFixture({ loadConfig: () => ({ config: stored }) });
    const failing = flowFixture();

    expect(createModelConfigFlow(loaded.options).currentThinkingLevel()).toBe("max");
    expect(createModelConfigFlow(failing.options).currentThinkingLevel()).toBe("low");
  });
});

function matchesPickerKey(data: string, keybinding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\u001b"],
  };
  return (keys[keybinding] ?? []).includes(data);
}
