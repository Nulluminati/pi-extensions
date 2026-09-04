// JSON schemas exposed through the three Context7 Pi tools.

// --- Tool parameter schemas ---

export const RESOLVE_LIBRARY_PARAMS = {
  type: "object",
  properties: {
    libraryName: {
      type: "string",
      description: "Library or package name to resolve in Context7.",
    },
    query: {
      type: "string",
      description: "Optional task or intent to help rank the best Context7 library match.",
    },
  },
  required: ["libraryName"],
};

export const GET_LIBRARY_DOCS_PARAMS = {
  type: "object",
  properties: {
    libraryId: {
      type: "string",
      description: "Exact Context7 library ID, such as /vercel/next.js.",
    },
    libraryName: {
      type: "string",
      description: "Library or package name when an exact Context7 ID is not known.",
    },
    query: {
      type: "string",
      description: "Freeform documentation request or question.",
    },
    topic: {
      type: "string",
      description: "Optional focused topic inside the docs.",
    },
    page: {
      type: "number",
      description: "Optional logical page number for repeated docs retrieval attempts.",
    },
  },
  required: [],
};

export const GET_CACHED_DOC_RAW_PARAMS = {
  type: "object",
  properties: {
    docRef: {
      type: "string",
      description: "Exact docRef returned by context7_get_library_docs.",
    },
    libraryId: {
      type: "string",
      description: "Optional Context7 library ID for semantic cache lookup.",
    },
    libraryName: {
      type: "string",
      description: "Optional library name for semantic cache lookup.",
    },
    libraryVersion: {
      type: "string",
      description: "Optional library version for semantic cache lookup.",
    },
    query: {
      type: "string",
      description: "Optional original query used to fetch docs.",
    },
    topic: {
      type: "string",
      description: "Optional original topic used to fetch docs.",
    },
    page: {
      type: "number",
      description: "Optional original logical page number.",
    },
    offsetLine: {
      type: "number",
      description:
        "Optional 1-based line offset for paging through documents larger than the per-call cap (2,000 lines / 40,000 chars). Use nextOffsetLine from a truncated result.",
    },
  },
  required: [],
};
