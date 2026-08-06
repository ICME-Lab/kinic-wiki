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

export const CONNECT_PRIVATE_TOOL_NAME = "connect_private" as const;

export const MCP_MUTATION_TOOL_NAMES = [
  "write_node",
  "append_node",
  "edit_node",
  "multi_edit_node",
  "mkdir_node",
  "move_node",
  "delete_node",
  "write_nodes",
  "mutate_nodes_batch"
] as const;

export type ToolAccessPolicy = "public" | "private_required" | "private_opt_in";

const NO_AUTH_SECURITY_SCHEME = { type: "noauth" } as const;
const oauthSecurityScheme = (scope: "mcp:read" | "mcp:write") => ({
  type: "oauth2" as const,
  scopes: [scope]
});

export function toolAuthMetadata(
  accessPolicy: ToolAccessPolicy,
  requiresPrivateConnection = false,
  scope: "mcp:read" | "mcp:write" = "mcp:read"
): { securitySchemes: Array<
  | typeof NO_AUTH_SECURITY_SCHEME
  | { type: "oauth2"; scopes: string[] }
> } {
  const oauth = oauthSecurityScheme(scope);
  if (requiresPrivateConnection || accessPolicy === "private_required") {
    return { securitySchemes: [oauth] };
  }
  if (accessPolicy === "private_opt_in") {
    return { securitySchemes: [NO_AUTH_SECURITY_SCHEME, oauth] };
  }
  return { securitySchemes: [NO_AUTH_SECURITY_SCHEME] };
}

export function mcpToolNames(privateConnectionAvailable: boolean, writesAvailable = false): string[] {
  if (!privateConnectionAvailable) {
    return [...MCP_TOOL_NAMES];
  }
  return writesAvailable
    ? [...MCP_TOOL_NAMES, CONNECT_PRIVATE_TOOL_NAME, ...MCP_MUTATION_TOOL_NAMES]
    : [...MCP_TOOL_NAMES, CONNECT_PRIVATE_TOOL_NAME];
}
