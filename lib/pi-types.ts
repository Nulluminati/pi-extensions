/**
 * Pi types that no public SDK entry exports.
 *
 * Each type is derived from public SDK types so it follows Pi when the SDK
 * changes. Do not copy SDK declarations here.
 */

import type {
  ExtensionUIContext,
  ProviderModelConfig,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

type SdkToolRenderContext<TState> = Parameters<
  NonNullable<ToolDefinition<TSchema, unknown, TState>["renderCall"]>
>[2];

/** Context passed to a tool's `renderCall` and `renderResult`. */
export type ToolRenderContext<TState = any, TArgs = any> = Omit<
  SdkToolRenderContext<TState>,
  "args"
> & { args: TArgs };

/** Factory passed to `ctx.ui.setEditorComponent`. */
export type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/** Chat model entry in a provider's `models` list. */
export type ProviderChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

/** Result of `Container.handleMouse`, which pi-tui's index does not export. */
export type TuiMouseDispatchResult = NonNullable<ReturnType<Container["handleMouse"]>>;
