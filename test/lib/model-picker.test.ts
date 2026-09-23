import type { SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "pi";
import { describe, expect, it, vi } from "vitest";
import {
  formatModelDescription,
  formatTokenCount,
  selectModelWithSearch,
} from "../../lib/model-picker.ts";

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
            { requestRender: vi.fn() },
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
