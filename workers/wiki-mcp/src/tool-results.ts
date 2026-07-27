// Where: workers/wiki-mcp/src/tool-results.ts
// What: Converts Wiki MCP payloads into MCP tool results with explicit model-facing text.
// Why: Model clients need readable page content while retaining structured output for validation.

type ToolPayload = Record<string, unknown>;

type FetchManyPayload = {
  results: Array<ToolPayload | null>;
};

type ReadPathsPayload = {
  results: ToolPayload[];
  metadata: ToolPayload;
};

export function toToolResult(payload: ToolPayload | ToolErrorResult) {
  return isToolErrorResult(payload)
    ? payload
    : { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
}

export function toFetchManyToolResult(payload: FetchManyPayload) {
  const text = payload.results
    .map((result, index) => {
      if (!result) {
        return `Result ${index + 1}\nError: missing result`;
      }
      if (result.is_error === true) {
        return `Result ${index + 1}\nError: ${String(result.error)}`;
      }
      const metadata = isRecord(result.metadata) ? result.metadata : {};
      return [
        `Result ${index + 1}`,
        `Path: ${String(metadata.path ?? "")}`,
        `Title: ${String(result.title ?? "")}`,
        "Content:",
        String(result.text ?? "")
      ].join("\n");
    })
    .join("\n\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload
  };
}

export function toFetchedNodeToolResult(payload: ToolPayload | ToolErrorResult) {
  if (isToolErrorResult(payload)) {
    return payload;
  }
  return {
    content: [{ type: "text" as const, text: modelFacingNodeText(payload) }],
    structuredContent: payload
  };
}

export function toReadPathsToolResult(payload: ReadPathsPayload | ToolErrorResult) {
  if (isToolErrorResult(payload)) {
    return payload;
  }
  const text = payload.results
    .map((result, index) =>
      result.is_error === true
        ? `Result ${index + 1}\nPath: ${String(result.path)}\nError: ${String(result.error)}`
        : `Result ${index + 1}\n${modelFacingNodeText(result)}`
    )
    .join("\n\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload
  };
}

export function toolError(message: string, payload: ToolPayload) {
  const contentPayload = { ...payload, error: typeof payload.error === "string" ? payload.error : message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(contentPayload) }],
    isError: true
  };
}

type ToolErrorResult = ReturnType<typeof toolError>;

function isToolErrorResult(value: ToolPayload | ToolErrorResult): value is ToolErrorResult {
  return value.isError === true;
}

function modelFacingNodeText(node: ToolPayload) {
  const metadata = isRecord(node.metadata) ? node.metadata : {};
  return [
    `Path: ${String(metadata.path ?? "")}`,
    `Title: ${String(node.title ?? "")}`,
    "Content:",
    String(node.text ?? "")
  ].join("\n");
}

function isRecord(value: unknown): value is ToolPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
