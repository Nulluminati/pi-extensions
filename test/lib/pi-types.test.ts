import type { ClassifierContext, ExtensionEventMap, MessageRenderer, ToolRenderContext } from "pi";
import { describe, expectTypeOf, it } from "vitest";

describe("Pi 1.1.0 interface declarations", () => {
  it("exposes recorded tool duration and output padding to renderers", () => {
    expectTypeOf<ToolRenderContext>()
      .toHaveProperty("durationMs")
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<ToolRenderContext>().toHaveProperty("outputPad").toEqualTypeOf<number>();
  });

  it("exposes cancellation and optional execution duration on events", () => {
    expectTypeOf<ExtensionEventMap["agent_settled"]>()
      .toHaveProperty("aborted")
      .toEqualTypeOf<boolean>();
    expectTypeOf<ExtensionEventMap["tool_execution_end"]>()
      .toHaveProperty("durationMs")
      .toEqualTypeOf<number | undefined>();
  });

  it("exposes output padding to custom message renderers", () => {
    expectTypeOf<Parameters<MessageRenderer>[1]>()
      .toHaveProperty("outputPad")
      .toEqualTypeOf<number>();
  });

  it("accepts image blocks in classifier context", () => {
    const context: ClassifierContext = {
      state: { task: "Check the screenshot" },
      images: [{ type: "image", data: "base64-image", mimeType: "image/png" }],
      questions: {},
    };
    expectTypeOf(context.images).toEqualTypeOf<
      { type: "image"; data: string; mimeType: string }[] | undefined
    >();
  });
});

describe("Pi 1.2.0 interface declarations", () => {
  type BeforeAgentStart = ExtensionEventMap["before_agent_start"];

  it("narrows before_agent_start user runs to the prompt and images", () => {
    type UserRun = Extract<BeforeAgentStart, { messageType: "user" }>;
    expectTypeOf<UserRun>().toHaveProperty("prompt").toEqualTypeOf<string>();
    expectTypeOf<UserRun>()
      .toHaveProperty("images")
      .toEqualTypeOf<{ type: "image"; data: string; mimeType: string }[] | undefined>();
    expectTypeOf<UserRun>().not.toHaveProperty("message");
  });

  it("narrows before_agent_start custom runs to the starting message", () => {
    type CustomRun = Extract<BeforeAgentStart, { messageType: "custom" }>;
    expectTypeOf<CustomRun>()
      .toHaveProperty("message")
      .toHaveProperty("customType")
      .toEqualTypeOf<string>();
    expectTypeOf<CustomRun>().not.toHaveProperty("prompt");
  });

  it("shares the system prompt and run kind across before_agent_start events", () => {
    expectTypeOf<BeforeAgentStart["systemPrompt"]>().toEqualTypeOf<string>();
    expectTypeOf<BeforeAgentStart["messageType"]>().toEqualTypeOf<"user" | "custom">();
  });
});
