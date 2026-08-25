// Where: workers/wiki-mcp/src/tool-metadata.ts
// What: Shared names, authentication metadata, and safety annotations for Wiki MCP tools.
// Why: Discovery metadata and registered tool annotations must stay consistent.

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false
} as const;

export const MUTATION_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  openWorldHint: false,
  destructiveHint: false
} as const;

export const DESTRUCTIVE_TOOL_ANNOTATIONS = {
  ...MUTATION_TOOL_ANNOTATIONS,
  openWorldHint: true,
  destructiveHint: true
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

export const MCP_MUTATION_TOOL_NAMES = [
  "write_nodes",
  "mutate_nodes_batch"
] as const;

export type ToolAccessPolicy = "public" | "private_required";

const NO_AUTH_SECURITY_SCHEME = { type: "noauth" } as const;
const oauthSecurityScheme = () => ({
  type: "oauth2" as const,
  scopes: ["mcp:read"]
});

export function toolAuthMetadata(
  accessPolicy: ToolAccessPolicy
): { securitySchemes: Array<
  | typeof NO_AUTH_SECURITY_SCHEME
  | { type: "oauth2"; scopes: string[] }
> } {
  const oauth = oauthSecurityScheme();
  if (accessPolicy === "private_required") {
    return { securitySchemes: [oauth] };
  }
  return { securitySchemes: [NO_AUTH_SECURITY_SCHEME] };
}

export function mcpToolNames(writesAvailable = false): string[] {
  return writesAvailable ? [...MCP_TOOL_NAMES, ...MCP_MUTATION_TOOL_NAMES] : [...MCP_TOOL_NAMES];
}
