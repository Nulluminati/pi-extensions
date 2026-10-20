/**
 * Tool `structuredContent` typing.
 *
 * Pi types `structuredContent` as `JsonValue` and serializes it as JSON.
 * Extension result data is plain JSON data, but TypeScript does not accept
 * interfaces as `JsonValue` (they have no index signature), so each tool
 * passes its data through this helper instead of an inline cast.
 */

import type { JsonValue } from "@earendil-works/pi-ai";

export function asStructuredContent(value: object): JsonValue {
  return value as JsonValue;
}
