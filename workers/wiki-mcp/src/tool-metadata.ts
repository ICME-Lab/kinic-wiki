// Where: workers/wiki-mcp/src/tool-metadata.ts
// What: Shared names and safety annotations for the public Wiki MCP tools.
// Why: Discovery metadata and registered tool annotations must stay consistent.

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false
} as const;

export const MCP_TOOL_NAMES = [
  "find_databases",
  "search",
  "fetch_many",
  "read_path",
  "read_paths",
  "list",
  "memory_manifest",
  "context"
] as const;
